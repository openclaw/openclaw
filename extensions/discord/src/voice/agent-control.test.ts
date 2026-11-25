import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
// Discord tests cover agent control plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeControlDiscordVoiceAgentRun } from "./agent-control.js";

const mocks = vi.hoisted(() => ({
  controlRealtimeVoiceAgentRun: vi.fn(),
  shouldAutoControlRealtimeVoiceAgentText: vi.fn(),
  getSessionEntryAsync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
  shouldAutoControlRealtimeVoiceAgentText: mocks.shouldAutoControlRealtimeVoiceAgentText,
}));

// mock-isolation: Isolate the plugin's speaker lifetime from storage and the shared control owner.
vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    agent: { session: { getSessionEntryAsync: mocks.getSessionEntryAsync } },
  }),
}));

function createEntry() {
  return {
    route: { sessionKey: "discord:g1:c1" },
    sessionLifecycle: { status: "active" },
  } as Parameters<typeof maybeControlDiscordVoiceAgentRun>[0]["entry"];
}

const authority = {
  accountId: "default",
  context: { senderIsOwner: true, speakerLabel: "Speaker" },
  isCurrent: () => true,
};

describe("maybeControlDiscordVoiceAgentRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldAutoControlRealtimeVoiceAgentText.mockReturnValue(true);
  });

  it("falls back for inactive cancel-like phrases", async () => {
    const result = {
      ok: true,
      active: false,
      mode: "cancel",
      sessionKey: "discord:g1:c1",
      message: "There is no active OpenClaw run to cancel.",
      speak: true,
      suppress: false,
    };
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue(result);

    await expect(
      maybeControlDiscordVoiceAgentRun({
        ...authority,
        entry: createEntry(),
        text: "cancel my meeting tomorrow",
      }),
    ).resolves.toEqual({ handled: false, result });
  });

  it("handles active cancel requests", async () => {
    const result = {
      ok: true,
      active: true,
      mode: "cancel",
      sessionKey: "discord:g1:c1",
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      suppress: false,
    };
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue(result);

    await expect(
      maybeControlDiscordVoiceAgentRun({
        ...authority,
        entry: createEntry(),
        text: "cancel that",
      }),
    ).resolves.toEqual({
      handled: true,
      result,
      speakText: "Cancelled the active OpenClaw run.",
    });
  });

  it("ignores non-control phrases", async () => {
    mocks.shouldAutoControlRealtimeVoiceAgentText.mockReturnValue(false);

    await expect(
      maybeControlDiscordVoiceAgentRun({
        ...authority,
        entry: createEntry(),
        text: "what is next",
      }),
    ).resolves.toEqual({ handled: false });
    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
  });

  it.each(["speaker-revoked", "session-closed", "worker-failed"] as const)(
    "refuses control when %s while caller policy is being read",
    async (scenario) => {
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const effect = vi.fn();
      let current = true;
      const entry = createEntry();
      mocks.getSessionEntryAsync.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        if (scenario === "worker-failed") {
          throw new Error("Session worker failed");
        }
        return undefined;
      });
      mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
        await params.getToolAuthorityOverlayAsync();
        params.assertCurrent();
        effect();
      });
      const pending = maybeControlDiscordVoiceAgentRun({
        ...authority,
        entry,
        text: "cancel that",
        isCurrent: () => current,
      });
      await awaitGateBeforeSettlement(entered.promise, pending, "Control skipped its worker read");
      if (scenario === "speaker-revoked") {
        current = false;
      }
      if (scenario === "session-closed") {
        entry.sessionLifecycle.status = "stopped";
      }
      resume.resolve();
      await expect(pending).rejects.toThrow(
        scenario === "worker-failed" ? "Session worker failed" : "authorization changed",
      );
      expect(effect).not.toHaveBeenCalled();
    },
  );
});
