import fs from "node:fs";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import {
  base64url,
  composeOutbound,
  generateIdentity,
  type GuardAdapter,
  type SignedReceipt,
  type Verdict,
} from "../protocol/index.js";
import { MemoryAuditStore } from "../protocol/memory-stores.test-support.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import {
  matchesReefPeerIdentity,
  sameReefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerIdentity,
  type ReefPeerTrust,
} from "./friend-types.js";
import { ReefDeliveredStore, ReviewApprovalStore } from "./state.js";
import type { ReefTransportClient } from "./transport.js";
import type {
  ReefDeliverySettlement,
  ReefOutboundDeliveryPreparation,
} from "./trust-store-format.js";
import { ReefPeerTrustChangedError, type ReefTrustStore } from "./trust-store.js";
import type { ReefKeys, ReefRejectionNoticeState } from "./types.js";

const model = "mock-2026-07-12";
const stateDirs: string[] = [];

export async function resetFlowStoresForTests(): Promise<void> {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

export function flowStores(deliveredMaxEntries?: number, reviewsMaxEntries?: number) {
  const stateDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "reef-flow-"));
  stateDirs.push(stateDir);
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return {
    runtime,
    stateDir,
    reviews: new ReviewApprovalStore(runtime, reviewsMaxEntries),
    delivered:
      deliveredMaxEntries === undefined
        ? new ReefDeliveredStore(runtime)
        : new ReefDeliveredStore(runtime, deliveredMaxEntries),
  };
}

export const allow: Verdict = {
  decision: "allow",
  category: "safe",
  reason: "Safe.",
  model,
  policyVersion: "v1",
};

export function guard(
  ...verdicts: Verdict[]
): GuardAdapter & { classify: ReturnType<typeof vi.fn<GuardAdapter["classify"]>> } {
  const classify = vi.fn<GuardAdapter["classify"]>(
    async (): Promise<Verdict> => verdicts[classify.mock.calls.length - 1] ?? verdicts.at(-1)!,
  );
  return { providerId: "mock", pinnedModel: model, classify };
}

export function reefKeys(identity = generateIdentity()): ReefKeys {
  return {
    ...identity,
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
    keyEpoch: 1,
  };
}

export function config() {
  return ReefChannelConfigSchema.parse({
    handle: "bob",
    email: "bob@example.com",
    guard: {
      provider: "openai",
      pinnedModel: model,
      apiKeyEnv: "REEF_TEST_KEY",
      policyVersion: "v1",
      timeoutMs: 1_000,
    },
  });
}

export function peerTrust(
  identity: ReturnType<typeof generateIdentity>,
  overrides: Partial<ReefPeerTrust> = {},
): ReefPeerTrust {
  return {
    autonomy: "bounded",
    ed25519PublicKey: identity.signing.publicKey,
    x25519PublicKey: identity.encryption.publicKey,
    keyEpoch: 1,
    safetyNumberChanged: false,
    approvedAt: 1,
    ...overrides,
  };
}

export function trust(initial: Record<string, ReefPeerTrust>) {
  const values = new Map(Object.entries(initial));
  const deliveries = new Map<
    string,
    {
      bodyHash: string;
      textHash?: string;
      recipient: ReefPeerIdentity;
      resendDisabled?: true;
      overdueNotifiedAt?: number;
      rejection?: {
        category?: string;
        notice?: ReefRejectionNoticeState;
      };
    }
  >();
  const rejectionNotices = new Map<string, ReefRejectionNoticeState>();
  const assertCurrent = (peer: string, expected: ReefPeerIdentity, autonomy?: ReefAutonomy) => {
    const current = values.get(peer);
    if (
      !matchesReefPeerIdentity(current, expected) ||
      (autonomy !== undefined && current?.autonomy !== autonomy)
    ) {
      throw new ReefPeerTrustChangedError(peer);
    }
  };
  const prepareOutboundDelivery = (
    peer: string,
    id: string,
  ): ReefOutboundDeliveryPreparation | undefined => {
    const friend = values.get(peer);
    if (!friend) {
      return undefined;
    }
    const key = `${peer}:${id}`;
    const expected = { ...friend };
    return {
      trust: structuredClone(friend),
      assertCurrent: () => assertCurrent(peer, expected),
      async record(binding, options = {}) {
        if (!matchesReefPeerIdentity(values.get(peer), binding.recipient)) {
          throw new ReefPeerTrustChangedError(peer);
        }
        if (deliveries.has(key)) {
          throw new Error(`duplicate delivery ${id}`);
        }
        deliveries.set(key, structuredClone({ ...binding, ...options }));
      },
    };
  };
  const reserve = (
    peer: string,
    id: string,
    recipient: ReefPeerIdentity,
    noticeState: ReefRejectionNoticeState,
  ) => {
    const key = `${peer}:${id}`;
    const current = deliveries.get(key);
    if (!current?.rejection || !sameReefPeerIdentity(current.recipient, recipient)) {
      throw new Error(`missing rejection ${id}`);
    }
    if (current.rejection.notice) {
      return { kind: "existing" as const, state: current.rejection.notice };
    }
    deliveries.set(key, {
      ...current,
      rejection: {
        ...current.rejection,
        notice: noticeState,
      },
    });
    return { kind: "reserved" as const };
  };
  const complete = (peer: string, id: string, noticeState: ReefRejectionNoticeState) => {
    const key = `${peer}:${id}`;
    const previous = rejectionNotices.get(peer);
    rejectionNotices.set(peer, {
      lastRejectionAt: Math.max(previous?.lastRejectionAt ?? 0, noticeState.lastRejectionAt),
      ...(previous?.lastResendAt !== undefined || noticeState.lastResendAt !== undefined
        ? {
            lastResendAt: Math.max(previous?.lastResendAt ?? 0, noticeState.lastResendAt ?? 0),
          }
        : {}),
    });
    const current = deliveries.get(key);
    if (!current) {
      return true;
    }
    if (!current?.rejection?.notice) {
      return false;
    }
    return deliveries.delete(key);
  };
  return {
    values,
    deliveries,
    rejectionNotices,
    store: {
      get: (peer: string) => values.get(peer),
      observePeer: (peer: string) => {
        const friend = values.get(peer);
        const expected = friend ? { ...friend } : undefined;
        return friend && expected
          ? {
              trust: structuredClone(friend),
              assertCurrent: () => assertCurrent(peer, expected, expected.autonomy),
            }
          : undefined;
      },
      prepareOutboundDelivery,
      readOutboundDelivery: (peer: string, id: string): ReefDeliverySettlement | undefined => {
        const key = `${peer}:${id}`;
        const current = deliveries.get(key);
        if (!current) {
          return undefined;
        }
        const delivery = structuredClone(current);
        const matches = (value: typeof current | undefined) =>
          value !== undefined &&
          value.bodyHash === delivery.bodyHash &&
          value.textHash === delivery.textHash &&
          sameReefPeerIdentity(value.recipient, delivery.recipient);
        return {
          delivery,
          assertCurrent: () => assertCurrent(peer, delivery.recipient),
          currentPeer: async () => values.get(peer),
          recovery: {
            assertCurrent: () => assertCurrent(peer, delivery.recipient),
            loadState: async () => rejectionNotices.get(peer),
            reserve: async (noticeState) => reserve(peer, id, delivery.recipient, noticeState),
            complete: async (noticeState) => complete(peer, id, noticeState),
            prepareOutboundDelivery: async (nextId) => prepareOutboundDelivery(peer, nextId),
          },
          async consume() {
            const latest = deliveries.get(key);
            if (latest?.rejection) {
              return "rejected";
            }
            return matches(latest) && deliveries.delete(key) ? "consumed" : "unavailable";
          },
          async discard() {
            return matches(deliveries.get(key)) && deliveries.delete(key);
          },
          async reject(category) {
            const latest = deliveries.get(key);
            if (!latest || !matches(latest)) {
              return undefined;
            }
            if (latest.rejection) {
              return latest.rejection;
            }
            const rejection = {
              ...(category ? { category } : {}),
              ...(latest.resendDisabled ? { notice: { lastRejectionAt: Date.now() } } : {}),
            };
            deliveries.set(key, { ...latest, rejection });
            return rejection;
          },
        };
      },
      rejectionNoticeState: (peer: string) => rejectionNotices.get(peer),
    } as unknown as ReefTrustStore,
  };
}

export function transport() {
  return {
    acknowledge: vi.fn(async (_peer: string, _id: string, _receipt: SignedReceipt) => ({
      result: "deleted",
    })),
    sendEnvelope: vi.fn(
      async (_peer: string, value: Parameters<ReefTransportClient["sendEnvelope"]>[1]) => ({
        id: value.id,
        status: "queued",
      }),
    ),
  };
}

export async function envelope(
  sender: ReturnType<typeof generateIdentity>,
  recipient: ReefKeys,
  id: string,
  text: string,
) {
  return (
    await composeOutbound({
      id,
      from: "alice#1",
      to: "bob#1",
      body: { text },
      senderSigningSecretKey: sender.signing.secretKey,
      recipientEncryptionPublicKey: recipient.encryption.publicKey,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(3)),
      policyVersion: "v1",
    })
  ).envelope;
}
