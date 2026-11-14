import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { inspectConversationBindingAsync } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { slackConversationRouteOwners } from "./conversation-route-owner.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import { setSlackRuntime } from "./runtime.js";

const { prepareConversationRouteOwnersAsync: prepareSlackConversationRouteOwners } =
  slackConversationRouteOwners;

const room = { channel: "slack", accountId: "default", conversationId: "channel:C123" };
const roomFor = (conversationId: string, parentConversationId?: string) => ({
  ...room,
  conversationId,
  parentConversationId,
});
function capabilities(enabled: boolean) {
  return {
    adapterAvailable: enabled,
    bindSupported: enabled,
    unbindSupported: enabled,
    placements: enabled ? ["current"] : [],
  };
}

let cfg: OpenClawConfig;
let service: ReturnType<typeof getSessionBindingService>;
let testStateDir = "";
let installationState: ReturnType<typeof registerSlackInstallationState>;
const bind = (
  targetSessionKey: string,
  conversation: typeof room & { parentConversationId?: string } = room,
) => service.bind({ targetSessionKey, targetKind: "session", conversation });
const unbind = (bindingId: string) => service.unbind({ bindingId, reason: "test cleanup" });

beforeEach(async () => {
  testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-bindings-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", testStateDir);
  cfg = { channels: { slack: {} } };
  setSlackRuntime({ config: { current: () => cfg } } as never);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
  );
  installationState = registerSlackInstallationState("default", "workspace");
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  service = getSessionBindingService();
});

afterEach(async () => {
  installationState.release();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  await closeOpenClawStateDatabaseAsync();
  setSlackRuntime(null as never);
  vi.unstubAllEnvs();
  await fs.rm(testStateDir, { recursive: true, force: true });
});

it("preserves workspace capability and binding mutations", async () => {
  const account = { channel: " Slack ", accountId: " DEFAULT " };
  expect(service.getCapabilities(account)).toEqual(capabilities(true));

  const first = await bind("agent:main:first");
  await service.touchAsync(first.bindingId, 1234);
  expect((await service.resolveByConversationAsync(room))?.metadata?.lastActivityAt).toBe(1234);

  const reassigned = await bind("agent:main:second");
  expect(reassigned.targetSessionKey).toBe("agent:main:second");
  await expect(unbind(reassigned.bindingId)).resolves.toEqual([reassigned]);
});

it("prepares thread, parent, and configured owners without touching binding liveness", async () => {
  cfg = { channels: { slack: { accounts: { default: {} } } } };
  for (const [conversationId, parentConversationId, agentId] of [
    ["C111", undefined, "main"],
    ["thread-1", "C111", "finance"],
    ["C222", undefined, "ops"],
  ] as const) {
    const ref = roomFor(conversationId, parentConversationId);
    const bound = await bind(`agent:${agentId}:bound`, ref);
    await service.touchAsync(bound.bindingId, 1234);
  }
  const inputs = [
    { kind: "channel" as const, peerId: "C111", threadId: "thread-1" },
    { kind: "channel" as const, peerId: "C222", threadId: "thread-missing" },
    { kind: "channel" as const, peerId: "C333" },
  ].map((conversation) => ({ cfg, accountId: "default", conversation }));
  const expected = ["finance", "ops", "main"].map((agentId) => ({ kind: "agent", agentId }));
  const prepared = await prepareSlackConversationRouteOwners(inputs, async (refs) => {
    const inspections = await Promise.all(refs.map(inspectConversationBindingAsync));
    return () => inspections;
  });
  expect(prepared.map((resolve) => resolve())).toEqual(expected);
  const thread = await service.resolveByConversationAsync(roomFor("thread-1", "C111"));
  expect(thread?.metadata?.lastActivityAt).toBe(1234);
});

it("does not advertise, select, or mutate bindings for a detected org install", async () => {
  const existing = await bind("agent:main:workspace");
  const originalActivityAt = existing.metadata?.lastActivityAt;

  installationState.update("enterprise");

  expect(service.getCapabilities({ channel: "slack", accountId: "default" })).toEqual(
    capabilities(false),
  );
  expect(await service.resolveByConversationAsync(room)).toBeNull();
  expect(await service.listBySessionAsync(existing.targetSessionKey)).toEqual([]);

  await service.touchAsync(existing.bindingId, 9999);
  await expect(bind("agent:main:enterprise")).rejects.toMatchObject({
    code: "BINDING_ADAPTER_UNAVAILABLE",
  });
  await expect(unbind(existing.bindingId)).resolves.toEqual([]);

  installationState.update("workspace");
  expect(await service.resolveByConversationAsync(room)).toMatchObject({
    bindingId: existing.bindingId,
    targetSessionKey: existing.targetSessionKey,
    metadata: { lastActivityAt: originalActivityAt },
  });
});
