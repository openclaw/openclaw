import {
  createMeetingBrowserFixture,
  useMeetingTestState,
} from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { zoomMeetingsPlugin } from "../index.js";

const resolveZoomMeetingsConfig = zoomMeetingsPlugin.config.resolveConfig;
const testState = useMeetingTestState(createOpenClawTestState);

const URL = "https://zoom.us/j/12345678904?pwd=runtime";
const urlWithPasscode = (passcode: string) => URL.replace("runtime", passcode);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type RuntimeHarnessOptions = {
  inCall?: boolean;
  meetingEnded?: boolean;
  pendingReason?: "admission" | "passcode";
  tabOpen?: boolean;
};

const pendingManualAction = (reason: "admission" | "passcode") => ({
  reason: `zoom-${reason}-required`,
  message: reason === "admission" ? "Waiting for host admission." : "Enter the meeting passcode.",
});

function runtimeHarness(options?: RuntimeHarnessOptions) {
  const pendingReason = options?.pendingReason ?? "passcode";
  const harness = createMeetingBrowserFixture({
    url: URL,
    tabId: "zoom-tab",
    title: "Zoom call",
    leaveSessionMatched: true,
    followOpenedUrl: true,
    tabOpen: options?.tabOpen,
    status: (state, script) => {
      const reportedMeetingEnded = state.meetingEnded;
      if (state.meetingEndedOnce) {
        state.meetingEnded = false;
        state.meetingEndedOnce = false;
      }
      return {
        inCall: state.inCall,
        meetingEnded: reportedMeetingEnded,
        micMuted: true,
        cameraOff: true,
        ...(!state.inCall
          ? {
              ...(pendingReason === "admission" ? { lobbyWaiting: true } : {}),
              manualAction: pendingManualAction(pendingReason),
            }
          : {}),
        ...(state.sessionConflict && script.includes("const allowSessionAdoption = false")
          ? {
              manualAction: {
                reason: "zoom-session-conflict",
                message: "This Zoom tab is owned by another active meeting session.",
              },
            }
          : {}),
        url: state.tabUrl,
        title: "Zoom call",
      };
    },
  });
  harness.state.inCall = options?.inCall ?? true;
  harness.state.meetingEnded = options?.meetingEnded ?? false;
  return harness;
}

type RuntimeInstance = InstanceType<typeof zoomMeetingsPlugin.Runtime>;
type RuntimeHarness = ReturnType<typeof runtimeHarness>;

function runtimeFixture(
  options: {
    harness?: RuntimeHarnessOptions;
    config?: Parameters<typeof resolveZoomMeetingsConfig>[0];
    fullConfig?: ConstructorParameters<typeof zoomMeetingsPlugin.Runtime>[0]["fullConfig"];
  } = {},
) {
  const harness = runtimeHarness(options.harness);
  const runtime = new zoomMeetingsPlugin.Runtime({
    config: resolveZoomMeetingsConfig(
      options.config ?? {
        defaultMode: "transcribe",
        chrome: { waitForInCallMs: 1 },
      },
    ),
    fullConfig: options.fullConfig ?? {},
    runtime: harness.runtime,
    logger,
  });
  testState.track(runtime, { readWarnings: () => logger.warn.mock.calls });
  return { harness, runtime };
}

function browserRequests(harness: RuntimeHarness, path: string) {
  return harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === path);
}

function browserActScripts(harness: RuntimeHarness, since = 0) {
  return harness.gatewayRequest.mock.calls
    .slice(since)
    .filter(([, params]) => params.path === "/act")
    .map(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return typeof fn === "string" ? fn : "";
    });
}

function joinMeeting(
  runtime: RuntimeInstance,
  request: Partial<Parameters<RuntimeInstance["join"]>[0]> = {},
) {
  return runtime.join({ url: URL, mode: "transcribe", ...request });
}

describe("Zoom meeting session flow", () => {
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const { harness, runtime } = runtimeFixture({
      fullConfig: { agents: { entries: { operator: {} } } },
    });
    const first = await joinMeeting(runtime);
    expect(first.session.agentId).toBe("operator");
    expect(first.session.chrome?.health).toMatchObject({ inCall: true, cameraOff: true });
    const reused = await joinMeeting(runtime, {
      url: `${URL.split("?")[0]}?context=%7b%22Tid%22%3a%22two%22%7d`,
    });
    expect(reused.session.id).toBe(first.session.id);
    expect(runtime.list()).toHaveLength(1);
    expect(await runtime.status(first.session.id)).toMatchObject({
      found: true,
      session: { id: first.session.id },
    });
    const transcriptStartCall = harness.gatewayRequest.mock.calls.length;
    expect(await runtime.transcript(first.session.id)).toMatchObject({
      found: true,
      lines: [],
      nextIndex: 0,
    });
    const transcriptActScripts = browserActScripts(harness, transcriptStartCall);
    expect(transcriptActScripts).toHaveLength(2);
    expect(transcriptActScripts[0]).toContain("const allowSessionAdoption = false");
    expect(transcriptActScripts[0]).toContain("const captureCaptions = true");
    expect(transcriptActScripts[1]).toContain("expectedSessionId");
    expect(await runtime.speak(first.session.id, "hello")).toMatchObject({
      found: true,
      spoken: false,
    });
    Object.assign(first.session.chrome?.health ?? {}, {
      audioInputActive: true,
      audioInputRouted: true,
      audioOutputActive: true,
      audioOutputRouted: true,
      captioning: true,
      providerConnected: true,
      realtimeReady: true,
    });
    expect(await runtime.leave(first.session.id)).toMatchObject({
      found: true,
      browserLeft: true,
      session: {
        state: "ended",
        chrome: {
          health: {
            audioInputActive: false,
            audioInputRouted: false,
            audioOutputActive: false,
            audioOutputRouted: false,
            captioning: false,
            inCall: false,
            manualAction: undefined,
            providerConnected: false,
            realtimeReady: false,
          },
        },
      },
    });
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("reads an archived transcript without reclaiming a newer live tab owner", async () => {
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.sessionConflict = true;
    harness.gatewayRequest.mockClear();
    expect(await runtime.transcript(joined.session.id)).toMatchObject({
      found: true,
      lines: [{ text: "Archived caption" }],
    });
    const actScripts = browserActScripts(harness);
    expect(actScripts).toHaveLength(2);
    expect(actScripts[0]).toContain("const allowSessionAdoption = false");
    expect(actScripts[1]).toContain("expectedSessionId");
  });

  it("recovers the tracked tab after Zoom rewrites the in-call URL", async () => {
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.tabUrl = "https://zoom.us/";
    harness.gatewayRequest.mockClear();
    const status = await runtime.status(joined.session.id);
    expect(status.session?.chrome?.health?.browserUrl).toBe("https://zoom.us/");
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: "zoom-tab" }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("ends the session when the tracked Zoom tab disappears", async () => {
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.tabOpen = false;

    const status = await runtime.status(joined.session.id);

    expect(status.session).toMatchObject({
      browserLeft: true,
      state: "ended",
      chrome: {
        browserTab: undefined,
        health: {
          inCall: false,
          manualAction: undefined,
          status: "browser-tab-missing",
        },
      },
    });
  });

  it("opens a new session when browser verification of a reusable tab fails", async () => {
    const { harness, runtime } = runtimeFixture({
      config: { defaultMode: "transcribe" },
    });
    const first = await joinMeeting(runtime);
    harness.state.tabListFailures = 1;
    const replacement = await joinMeeting(runtime);

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
  });

  it("rejects and closes the tab when the initial browser status is host-ended", async () => {
    const { harness, runtime } = runtimeFixture({
      harness: { inCall: false, meetingEnded: true },
    });

    await expect(joinMeeting(runtime)).rejects.toThrow("The Zoom meeting has already ended.");

    expect(runtime.list()).toEqual([]);
    expect(
      browserRequests(harness, "/tabs/zoom-tab").filter(([, params]) => params.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("ends the active session when browser status confirms the host ended it", async () => {
    const { harness, runtime } = runtimeFixture();
    const joined = await joinMeeting(runtime);
    harness.state.inCall = false;
    harness.state.meetingEnded = true;

    const status = await runtime.status(joined.session.id);

    expect(status.session).toMatchObject({
      browserLeft: true,
      chrome: { health: { inCall: false, meetingEnded: true } },
      state: "ended",
    });
  });

  it("serializes concurrent corrected passcodes under the meeting join lock", async () => {
    const { harness, runtime } = runtimeFixture({ harness: { inCall: false } });
    const first = await joinMeeting(runtime, { url: urlWithPasscode("old") });

    const [second, third] = await Promise.all([
      joinMeeting(runtime, { url: urlWithPasscode("correct-one") }),
      joinMeeting(runtime, { url: urlWithPasscode("correct-two") }),
    ]);

    expect(first.session.state).toBe("ended");
    expect(second.session.state).toBe("ended");
    expect(third.session.state).toBe("active");
    expect(new Set([first.session.id, second.session.id, third.session.id]).size).toBe(3);
    expect(browserRequests(harness, "/tabs/open")).toHaveLength(3);
  });
});
