import type { RealtimeVoiceSelectionHandle } from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockIngressInput = {
  accountId?: string;
  message?: string;
  sessionKey?: string;
  runId?: string;
  senderIsOwner?: boolean;
};

const mocks = vi.hoisted(() => ({
  agentCommandFromIngress: vi.fn(async (_input: MockIngressInput) => ({
    payloads: [{ text: "spoken" }],
  })),
}));

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    agent: { runCommandFromIngress: mocks.agentCommandFromIngress },
  }),
}));

import { runDiscordVoiceAgentTurn } from "./ingress.js";

describe("Discord voice ingress execution correlation", () => {
  beforeEach(() => mocks.agentCommandFromIngress.mockClear());
  it.each([
    { owner: true, fail: false },
    { owner: true, fail: true },
    { owner: false, fail: false },
    { owner: false, fail: true },
  ])(
    "binds an admitted voice command for its lifetime (owner=$owner, failure=$fail)",
    async ({ owner, fail }) => {
      const release = vi.fn();
      const bindRun = vi.fn(() => release);
      const entry = {
        captureOnly: false,
        sessionLifecycle: { status: "active" },
        route: { agentId: "main", sessionKey: "agent:main:discord:voice:room" },
      };
      mocks.agentCommandFromIngress.mockImplementationOnce(async (input) => {
        expect(bindRun).toHaveBeenCalledWith(expect.objectContaining({ runId: input.runId }));
        expect(input.runId).toEqual(expect.any(String));
        expect(input.senderIsOwner).toBe(owner);
        expect(release).not.toHaveBeenCalled();
        if (fail) {
          throw new Error("Agent turn failed");
        }
        return { payloads: [{ text: "Voice changed." }] };
      });
      const turn = runDiscordVoiceAgentTurn({
        entry: entry as never,
        accountId: "work",
        userId: owner ? "owner" : "guest",
        message: "Change your voice",
        cfg: {},
        discordConfig: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        context: { senderIsOwner: owner, speakerLabel: owner ? "Owner" : "Guest" },
        voiceSelection: { bindRun, unregister: vi.fn() },
        fetchGuildName: vi.fn(async () => "Guild"),
        speakerContext: {} as never,
      });
      if (fail) {
        await expect(turn).rejects.toThrow("Agent turn failed");
      } else {
        await expect(turn).resolves.toMatchObject({ text: "Voice changed." });
      }
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each(["policy", "call", "abort"] as const)(
    "revokes a non-owner voice binding when %s authority ends during the turn",
    async (revoked) => {
      const release = vi.fn();
      const bindRun = vi.fn<RealtimeVoiceSelectionHandle["bindRun"]>(() => release);
      const cancellation = new AbortController();
      let current = true;
      const entry = {
        captureOnly: false,
        sessionLifecycle: { status: "active" },
        route: { agentId: "main", sessionKey: "agent:main:discord:voice:room" },
      };
      mocks.agentCommandFromIngress.mockImplementationOnce(async () => {
        expect(bindRun).toHaveBeenCalledOnce();
        const binding = bindRun.mock.calls[0]![0];
        expect(binding.assertCurrent).not.toThrow();
        if (revoked === "policy") {
          current = false;
        } else if (revoked === "call") {
          entry.sessionLifecycle.status = "stopped";
        } else {
          cancellation.abort(new Error("Voice turn cancelled"));
        }
        expect(binding.assertCurrent).toThrow(
          revoked === "abort" ? "Voice turn cancelled" : "Discord voice access is no longer valid",
        );
        return { payloads: [{ text: "Voice change unavailable." }] };
      });
      await runDiscordVoiceAgentTurn({
        entry: entry as never,
        accountId: "work",
        userId: "guest",
        message: "Change your voice",
        cfg: {},
        discordConfig: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        context: { senderIsOwner: false, speakerLabel: "Guest", isCurrent: () => current },
        voiceSelection: { bindRun, unregister: vi.fn() },
        signal: cancellation.signal,
        fetchGuildName: vi.fn(async () => "Guild"),
        speakerContext: {} as never,
      });
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("admits sequential batch voice turns without inventing a public run id", async () => {
    const entry = {
      guildId: "guild-1",
      channelId: "channel-1",
      captureOnly: false,
      sessionLifecycle: { status: "active" },
      route: { agentId: "main", sessionKey: "agent:main:discord:channel:channel-1" },
    };
    const shared = {
      entry: entry as never,
      accountId: "work",
      userId: "user-1",
      cfg: {} as never,
      discordConfig: {} as never,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      context: { senderIsOwner: false, speakerLabel: "Guest" },
      fetchGuildName: vi.fn(async () => "Guild"),
      speakerContext: {} as never,
    };

    await runDiscordVoiceAgentTurn({ ...shared, message: "first turn" });
    await runDiscordVoiceAgentTurn({ ...shared, message: "second turn" });

    expect(mocks.agentCommandFromIngress).toHaveBeenCalledTimes(2);
    const inputs = mocks.agentCommandFromIngress.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => input.message)).toEqual(["first turn", "second turn"]);
    expect(inputs.map((input) => input.sessionKey)).toEqual([
      "agent:main:discord:channel:channel-1",
      "agent:main:discord:channel:channel-1",
    ]);
    expect(inputs.map((input) => input.accountId)).toEqual(["work", "work"]);
    for (const input of inputs) {
      expect(input).not.toHaveProperty("runId");
    }
  });

  it.each([
    { owner: true, state: "active", captureOnly: false },
    { owner: false, state: "active", captureOnly: false },
    { owner: false, state: "stopped", captureOnly: false },
    { owner: false, state: "active", captureOnly: true },
  ] as const)(
    "dispatches only active conversational ingress (owner=$owner, state=$state, captureOnly=$captureOnly)",
    async ({ owner, state, captureOnly }) => {
      const callsBefore = mocks.agentCommandFromIngress.mock.calls.length;
      const result = await runDiscordVoiceAgentTurn({
        entry: {
          guildId: "guild-1",
          channelId: "channel-1",
          captureOnly,
          sessionLifecycle:
            state === "active" ? { status: state } : { status: state, reason: "left" },
          route: { agentId: "main", sessionKey: "agent:main:discord:channel:channel-1" },
        } as never,
        accountId: "work",
        userId: owner ? "owner-1" : "guest-1",
        message: "run the tool",
        cfg: {} as never,
        discordConfig: {} as never,
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        context: { senderIsOwner: owner, speakerLabel: owner ? "Owner" : "Guest" },
        fetchGuildName: vi.fn(async () => "Guild"),
        speakerContext: {} as never,
      });

      if (captureOnly || state !== "active") {
        expect(result).toBeNull();
        expect(mocks.agentCommandFromIngress).toHaveBeenCalledTimes(callsBefore);
        return;
      }
      expect(mocks.agentCommandFromIngress).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageChannel: "discord", senderIsOwner: owner }),
        expect.anything(),
      );
    },
  );
});
