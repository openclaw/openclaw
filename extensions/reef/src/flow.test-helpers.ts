import fs from "node:fs";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import {
  base64url,
  seal,
  generateIdentity,
  type GuardAdapter,
  type SignedReceipt,
  type ReplayStore,
  type Verdict,
} from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { openReefAuditStore } from "./audit-state.js";
import { ReefChannelConfigSchema, type ReefChannelConfig } from "./config-schema.js";
import { ReefMessageFlow } from "./flow.js";
import type { ReefPeerTrust } from "./friend-types.js";
import { ReefDeliveredStore, ReviewApprovalStore } from "./state.js";
import { createRuntime } from "./state.test-support.js";
import type { ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";
import type { ReefKeys } from "./types.js";

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
  const runtime = createRuntime(stateDir);
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

export async function workerFlowStores(
  cfg: ReefChannelConfig,
  peers: Record<string, ReefPeerTrust>,
  options: { deliveredMaxEntries?: number } = {},
) {
  const stores = flowStores(options.deliveredMaxEntries);
  const trusted = openReefTrustStore(stores.runtime, cfg);
  for (const [peer, value] of Object.entries(peers)) {
    await trusted.set(peer, value);
  }
  return {
    ...stores,
    trusted,
    audit: openReefAuditStore(stores.runtime, new Uint8Array(32).fill(10)),
  };
}

export async function createFlow({
  handle = "bob",
  peer = "alice",
  verdicts = [allow],
  replay = new MemoryReplayStore(),
  onOwnerNotice = async () => {},
}: {
  handle?: string;
  peer?: string;
  verdicts?: Verdict[];
  replay?: ReplayStore;
  onOwnerNotice?: ConstructorParameters<typeof ReefMessageFlow>[0]["onOwnerNotice"];
} = {}) {
  const keys = reefKeys();
  const peerKeys = generateIdentity();
  const cfg = { ...config(), handle };
  const { trusted, audit, ...stores } = await workerFlowStores(cfg, {
    [peer]: peerTrust(peerKeys),
  });
  const relay = transport();
  const classifier = guard(...verdicts);
  const onIngress = vi.fn<ConstructorParameters<typeof ReefMessageFlow>[0]["onIngress"]>(
    async () => {},
  );
  const flow = new ReefMessageFlow({
    config: cfg,
    trust: trusted,
    keys,
    transport: relay as unknown as ReefTransportClient,
    guard: classifier,
    audit,
    replay,
    ...stores,
    onIngress: async (message, assertCurrent) => {
      assertCurrent();
      await onIngress(message, assertCurrent);
    },
    onOwnerNotice,
  });
  return { keys, peerKeys, trusted, relay, stores, classifier, audit, onIngress, flow };
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
  return seal({
    id,
    from: "alice#1",
    to: "bob#1",
    body: { text },
    senderSigningSecretKey: sender.signing.secretKey,
    recipientEncryptionPublicKey: recipient.encryption.publicKey,
  });
}
