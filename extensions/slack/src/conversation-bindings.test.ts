// Slack tests cover account-scoped runtime conversation binding admission.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slackPlugin } from "./channel.js";
import { slackConversationRouteOwners } from "./conversation-route-owner.js";
import { inspectSlackConversationRouteOwner } from "./conversation-route-owner.test-support.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import { setSlackRuntime } from "./runtime.js";

const { prepareConversationRouteOwnersAsync: prepareSlackConversationRouteOwners } =
  slackConversationRouteOwners;

type SlackInstallationStateRegistration = ReturnType<typeof registerSlackInstallationState>;

const CONVERSATION = {
  channel: "slack",
  accountId: "default",
  conversationId: "channel:C123",
};

describe("Slack runtime conversation bindings", () => {
  let cfg: OpenClawConfig;
  let previousStateDir: string | undefined;
  let testStateDir = "";
  let installationState: SlackInstallationStateRegistration;

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    cfg = { channels: { slack: {} } };
    setSlackRuntime({ config: { current: () => cfg } } as never);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
    );
    installationState = registerSlackInstallationState("default", "workspace");
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  afterEach(async () => {
    installationState.release();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    await closeOpenClawStateDatabaseAsync();
    setSlackRuntime(null as never);
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("preserves workspace capability and binding mutations", async () => {
    const service = getSessionBindingService();
    expect(service.getCapabilities({ channel: " Slack ", accountId: " DEFAULT " })).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });

    const first = await service.bind({
      targetSessionKey: "agent:main:first",
      targetKind: "session",
      conversation: CONVERSATION,
    });
    await service.touchAsync(first.bindingId, 1234);
    expect((await service.resolveByConversationAsync(CONVERSATION))?.metadata?.lastActivityAt).toBe(
      1234,
    );

    const reassigned = await service.bind({
      targetSessionKey: "agent:main:second",
      targetKind: "session",
      conversation: CONVERSATION,
    });
    expect(reassigned.targetSessionKey).toBe("agent:main:second");
    await expect(
      service.unbind({ bindingId: reassigned.bindingId, reason: "workspace cleanup" }),
    ).resolves.toEqual([reassigned]);
  });

  it("prepares thread, parent, and configured owners from supplied binding inspection", async () => {
    cfg = { channels: { slack: { accounts: { default: {} } } } };
    const service = getSessionBindingService();
    for (const [conversationId, parentConversationId, agentId] of [
      ["C111", undefined, "main"],
      ["thread-1", "C111", "finance"],
      ["C222", undefined, "ops"],
    ] as const) {
      await service.bind({
        targetSessionKey: `agent:${agentId}:bound`,
        targetKind: "session",
        conversation: {
          channel: "slack",
          accountId: "default",
          conversationId,
          ...(parentConversationId ? { parentConversationId } : {}),
        },
      });
    }
    const inputs = [
      {
        cfg,
        accountId: "default",
        conversation: { kind: "channel" as const, peerId: "C111", threadId: "thread-1" },
      },
      {
        cfg,
        accountId: "default",
        conversation: { kind: "channel" as const, peerId: "C222", threadId: "thread-missing" },
      },
      { cfg, accountId: "default", conversation: { kind: "channel" as const, peerId: "C333" } },
    ];
    const expected = ["finance", "ops", "main"].map((agentId) => ({ kind: "agent", agentId }));
    expect(await Promise.all(inputs.map(inspectSlackConversationRouteOwner))).toEqual(expected);
    const prepared = await prepareSlackConversationRouteOwners(inputs, async (refs) => {
      const inspections = await Promise.all(refs.map(inspectConversationBindingAsync));
      return () => inspections;
    });
    expect(prepared.map((resolve) => resolve())).toEqual(expected);
  });

  it("does not advertise, select, or mutate bindings for a detected org install", async () => {
    const service = getSessionBindingService();
    const existing = await service.bind({
      targetSessionKey: "agent:main:workspace",
      targetKind: "session",
      conversation: CONVERSATION,
    });
    const originalActivityAt = existing.metadata?.lastActivityAt;

    installationState.update("enterprise");

    expect(service.getCapabilities({ channel: "slack", accountId: "default" })).toEqual({
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    });
    expect(await service.resolveByConversationAsync(CONVERSATION)).toBeNull();
    expect(await service.listBySessionAsync(existing.targetSessionKey)).toEqual([]);

    await service.touchAsync(existing.bindingId, 9999);
    await expect(
      service.bind({
        targetSessionKey: "agent:main:enterprise",
        targetKind: "session",
        conversation: CONVERSATION,
      }),
    ).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
    await expect(
      service.unbind({ bindingId: existing.bindingId, reason: "enterprise cleanup" }),
    ).resolves.toEqual([]);

    installationState.update("workspace");
    expect(await service.resolveByConversationAsync(CONVERSATION)).toMatchObject({
      bindingId: existing.bindingId,
      targetSessionKey: existing.targetSessionKey,
      metadata: { lastActivityAt: originalActivityAt },
    });
  });
});
