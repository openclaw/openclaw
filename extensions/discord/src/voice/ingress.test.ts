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
  modernContextAvailable: true,
  agentContext:
    vi.fn<
      typeof import("openclaw/plugin-sdk/realtime-bootstrap-context").resolveRealtimeVoiceAgentContextInstructions
    >(),
  bootstrapContext:
    vi.fn<
      typeof import("openclaw/plugin-sdk/realtime-bootstrap-context").resolveRealtimeBootstrapContextInstructions
    >(),
  agentCommandFromIngress: vi.fn(async (_input: MockIngressInput) => ({
    payloads: [{ text: "spoken" }],
  })),
}));

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", () => ({
  get resolveRealtimeVoiceAgentContextInstructions() {
    return mocks.modernContextAvailable ? mocks.agentContext : undefined;
  },
  resolveRealtimeBootstrapContextInstructions: mocks.bootstrapContext,
}));

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    agent: { runCommandFromIngress: mocks.agentCommandFromIngress },
  }),
}));

import { resolveDiscordVoiceRealtimeAgentContext, runDiscordVoiceAgentTurn } from "./ingress.js";

describe("Discord realtime context host compatibility", () => {
  beforeEach(() => {
    mocks.modernContextAvailable = true;
    mocks.agentContext.mockReset().mockResolvedValue("Agent context: modern host instructions.");
    mocks.bootstrapContext.mockReset().mockResolvedValue("Legacy host profile context.");
  });

  const resolveContext = (files?: readonly []) =>
    resolveDiscordVoiceRealtimeAgentContext({
      entry: { route: { agentId: "main", sessionKey: "agent:main:discord:voice:room" } },
      cfg: {},
      discordConfig: {
        voice: { realtime: { bootstrapContextFiles: files ? [...files] : undefined } },
      },
    });

  it("uses the modern composer even with an empty profile selection", async () => {
    await expect(resolveContext([])).resolves.toBe("Agent context: modern host instructions.");
    expect(mocks.agentContext).toHaveBeenCalledWith({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:discord:voice:room",
      files: [],
      warn: expect.any(Function),
    });
    expect(mocks.bootstrapContext).not.toHaveBeenCalled();
  });

  it("propagates modern composer failures without switching context owners", async () => {
    const error = new Error("modern context failed");
    mocks.agentContext.mockRejectedValueOnce(error);
    await expect(resolveContext()).rejects.toBe(error);
    expect(mocks.bootstrapContext).not.toHaveBeenCalled();
  });

  it("uses the shipped profile resolver only when the modern composer is absent", async () => {
    mocks.modernContextAvailable = false;
    await expect(resolveContext()).resolves.toBe("Legacy host profile context.");
    expect(mocks.bootstrapContext).toHaveBeenCalledWith({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:discord:voice:room",
      files: undefined,
      warn: expect.any(Function),
    });
    expect(mocks.agentContext).not.toHaveBeenCalled();
  });

  it("retains the shipped empty-files opt-out without reading profiles", async () => {
    mocks.modernContextAvailable = false;
    await expect(resolveContext([])).resolves.toBeUndefined();
    expect(mocks.bootstrapContext).not.toHaveBeenCalled();
    expect(mocks.agentContext).not.toHaveBeenCalled();
  });

  it("retains best-effort profile failures on the legacy host", async () => {
    mocks.modernContextAvailable = false;
    mocks.bootstrapContext.mockRejectedValueOnce(new Error("legacy profile failed"));
    await expect(resolveContext()).resolves.toBeUndefined();
    expect(mocks.bootstrapContext).toHaveBeenCalledOnce();
  });
});

describe("Discord voice ingress execution correlation", () => {
  beforeEach(() => mocks.agentCommandFromIngress.mockClear());
  function fixture(senderIsOwner = false) {
    const entry = {
      guildId: "guild-1",
      channelId: "channel-1",
      captureOnly: false,
      sessionLifecycle: { status: "active" },
      route: { agentId: "main", sessionKey: "agent:main:discord:channel:channel-1" },
    };
    return {
      entry,
      run: (overrides: Partial<Parameters<typeof runDiscordVoiceAgentTurn>[0]> = {}) =>
        runDiscordVoiceAgentTurn({
          entry: entry as never,
          accountId: "work",
          userId: senderIsOwner ? "owner" : "guest",
          message: "Change your voice",
          discordConfig: {},
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          context: { senderIsOwner, speakerLabel: senderIsOwner ? "Owner" : "Guest" },
          ...overrides,
        }),
    };
  }

  it.each([
    { owner: true, fail: false },
    { owner: false, fail: true },
  ])(
    "binds an admitted voice command for its lifetime (owner=$owner, failure=$fail)",
    async ({ owner, fail }) => {
      const release = vi.fn();
      const bindRun = vi.fn(() => release);
      const { run } = fixture(owner);
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
      const turn = run({ voiceSelection: { bindRun, unregister: vi.fn() } });
      if (fail) {
        await expect(turn).rejects.toThrow("Agent turn failed");
      } else {
        await expect(turn).resolves.toBe("Voice changed.");
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
      const { entry, run } = fixture();
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
      await run({
        context: { senderIsOwner: false, speakerLabel: "Guest", isCurrent: () => current },
        voiceSelection: { bindRun, unregister: vi.fn() },
        signal: cancellation.signal,
      });
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("admits sequential batch voice turns without inventing a public run id", async () => {
    const { run } = fixture();
    await run({ message: "first turn" });
    await run({ message: "second turn" });

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
    { state: "stopped", captureOnly: false },
    { state: "active", captureOnly: true },
  ] as const)(
    "rejects nonconversational ingress (state=$state, captureOnly=$captureOnly)",
    async ({ state, captureOnly }) => {
      const { entry, run } = fixture();
      entry.captureOnly = captureOnly;
      entry.sessionLifecycle.status = state;
      await expect(run()).resolves.toBeNull();
      expect(mocks.agentCommandFromIngress).not.toHaveBeenCalled();
    },
  );
});
