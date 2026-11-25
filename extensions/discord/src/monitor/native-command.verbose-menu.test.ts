import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import * as registry from "openclaw/plugin-sdk/plugin-test-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { discordPlugin } from "../../api.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { nativeCommandContext } from "./native-command.dispatch.test-support.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof conversationRuntime>()),
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
}));

const userId = "123456789012345678";
const channelId = "234567890123456789";
const acpBinding: NonNullable<OpenClawConfig["bindings"]>[number] = {
  type: "acp",
  agentId: "target",
  match: { channel: "discord", accountId: "default", peer: { kind: "direct", id: channelId } },
  acp: { mode: "persistent" },
};
const replies = {
  ready: "Current verbose level: full.\nChoose on, off, or full for /verbose.",
  unavailable: "Configured ACP binding is unavailable right now. Please try again.",
  unauthorized: "You are not authorized to use this command.",
};
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "discord-verbose-menu" });
  registry.setActivePluginRegistry(
    registry.createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  registry.setActivePluginRegistry(registry.createTestRegistry([]));
  await state.cleanup();
});

it.each(["ready", "unavailable", "unauthorized"] as const)(
  "preserves the %s command route",
  async (mode) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { target: { verboseDefault: "full" } } },
      commands: { allowFrom: { discord: [`user:${userId}`] } },
      channels: { discord: { dmPolicy: "allowlist", allowFrom: [userId], dm: { enabled: true } } },
      bindings: mode === "unavailable" ? [acpBinding] : undefined,
    };
    await state.writeConfig(cfg);
    vi.mocked(conversationRuntime.ensureConfiguredBindingRouteReady).mockResolvedValue(
      mode === "unavailable" ? { ok: false, error: "fixture unavailable" } : { ok: true },
    );
    const interaction = createMockCommandInteraction({
      userId: mode === "unauthorized" ? "987654321098765432" : userId,
      channelId,
    });
    const dispatch = vi.spyOn(channelInbound, "dispatchChannelInboundTurn");
    const record = vi
      .spyOn(transcriptRuntime, "recordDeliveredCommandExchange")
      .mockResolvedValue({ ok: false, reason: "recording disabled in adapter test" });
    await createDiscordNativeCommand({
      command: { name: "verbose", description: "Verbose mode", acceptsArgs: true },
      ...nativeCommandContext(cfg),
      ephemeralDefault: true,
    }).run(interaction);
    if (mode === "unavailable") {
      expect(conversationRuntime.ensureConfiguredBindingRouteReady).toHaveBeenCalled();
    }
    expect(dispatch).not.toHaveBeenCalled();
    const payload = interaction.followUp.mock.calls[0]?.[0];
    expect(payload?.content).toBe(replies[mode]);
    expect(Boolean(payload?.components?.length)).toBe(mode === "ready");
    expect(record).toHaveBeenCalledTimes(mode === "ready" ? 1 : 0);
    if (mode === "ready") {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          commandText: "/verbose",
          replyId: "argument-menu",
          replyText: expect.stringContaining("Choose on, off, or full for /verbose."),
        }),
      );
    }
  },
);

installDiscordIngressTestRuntime();
