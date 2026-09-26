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
import { ReefChannelConfigSchema, type ReefChannelConfig } from "./config-schema.js";
import type { ReefPeerTrust } from "./friend-types.js";
import { ReefDeliveredStore, ReviewApprovalStore } from "./state.js";
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

export function flowStores(deliveredMaxEntries?: number) {
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
    reviews: new ReviewApprovalStore(runtime),
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
): GuardAdapter & { classify: ReturnType<typeof vi.fn> } {
  const classify = vi.fn(async () => verdicts[classify.mock.calls.length - 1] ?? verdicts.at(-1)!);
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

export function trust(
  runtime: Parameters<typeof openReefTrustStore>[0],
  cfg: ReefChannelConfig,
  initial: Record<string, ReefPeerTrust>,
) {
  const store = openReefTrustStore(runtime, cfg);
  for (const [peer, value] of Object.entries(initial)) {
    store.set(peer, value);
  }
  return store;
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
