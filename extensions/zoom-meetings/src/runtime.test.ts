import {
  createMeetingBrowserFixture,
  defineMeetingSessionFlowTests,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { zoomMeetingsConfig } from "./config.js";
import { ZoomMeetingsRuntime } from "./runtime.js";

const resolveZoomMeetingsConfig = zoomMeetingsConfig.resolveConfig;

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

type RuntimeInstance = InstanceType<typeof ZoomMeetingsRuntime>;
type RuntimeHarness = ReturnType<typeof runtimeHarness>;

function runtimeFixture(
  options: {
    harness?: RuntimeHarnessOptions;
    config?: Parameters<typeof resolveZoomMeetingsConfig>[0];
    fullConfig?: ConstructorParameters<typeof ZoomMeetingsRuntime>[0]["fullConfig"];
  } = {},
) {
  const harness = runtimeHarness(options.harness);
  const runtime = new ZoomMeetingsRuntime({
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
  return { harness, runtime };
}

function browserRequests(harness: RuntimeHarness, path: string) {
  return harness.gatewayRequest.mock.calls.filter(([, params]) => params.path === path);
}

function joinMeeting(
  runtime: RuntimeInstance,
  request: Partial<Parameters<RuntimeInstance["join"]>[0]> = {},
) {
  return runtime.join({ url: URL, mode: "transcribe", ...request });
}

describe("Zoom meeting session flow", () => {
  defineMeetingSessionFlowTests({
    createFixture: runtimeFixture,
    url: URL,
    tabId: "zoom-tab",
    rewrittenUrl: "https://zoom.us/",
    rewrittenUrlTestName: "recovers the tracked tab after Zoom rewrites the in-call URL",
    endedHealth: { inCall: false, manualAction: undefined },
  });

  it("adopts the in-call page statefully after host admission", async () => {
    const { harness, runtime } = runtimeFixture({
      harness: { inCall: false, pendingReason: "admission" },
    });
    const joined = await joinMeeting(runtime);
    harness.state.inCall = true;
    harness.gatewayRequest.mockClear();

    const status = await runtime.status(joined.session.id);

    const statusScript = harness.gatewayRequest.mock.calls
      .filter(([, params]) => params.path === "/act")
      .map(([, params]) => (params.body as { fn?: unknown } | undefined)?.fn)
      .find((fn): fn is string => typeof fn === "string" && fn.includes("const readOnly"));
    expect(statusScript).toContain("const readOnly = false");
    expect(status.session?.chrome?.health).toMatchObject({ inCall: true });
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

  it.each([
    ["opens a new session instead of reusing one whose Zoom tab disappeared", "missing-tab"],
    [
      "opens a new session when browser verification of a reusable tab fails",
      "verification-failure",
    ],
    ["replaces a reusable session whose realtime bridge closed", "bridge-closed"],
    ["closes a host-ended tab before opening its replacement", "host-ended"],
  ] as const)("%s", async (_title, scenario) => {
    const { harness, runtime } = runtimeFixture({
      config: scenario === "verification-failure" ? { defaultMode: "transcribe" } : undefined,
    });
    const first = await joinMeeting(runtime);
    if (scenario === "missing-tab") {
      harness.state.tabOpen = false;
    } else if (scenario === "verification-failure") {
      harness.state.tabListFailures = 1;
    } else if (scenario === "bridge-closed") {
      Object.assign(first.session.chrome?.health ?? {}, { bridgeClosed: true });
    } else {
      harness.state.inCall = false;
      harness.state.meetingEnded = true;
      harness.state.meetingEndedOnce = true;
    }

    const replacement = await joinMeeting(runtime);

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    if (scenario !== "verification-failure") {
      expect(browserRequests(harness, "/tabs/open")).toHaveLength(2);
    }
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

  it("restarts a failed join when the corrected invite changes the passcode", async () => {
    const { harness, runtime } = runtimeFixture({ harness: { inCall: false } });
    const first = await joinMeeting(runtime, { url: urlWithPasscode("old") });

    const corrected = await joinMeeting(runtime, { url: urlWithPasscode("correct") });

    expect(corrected.session.id).not.toBe(first.session.id);
    expect(first.session.state).toBe("ended");
    expect(browserRequests(harness, "/tabs/open")).toHaveLength(2);
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

  it("serializes cross-agent reassignment through the core join owner", async () => {
    const { harness, runtime } = runtimeFixture({ harness: { inCall: false } });
    const first = await joinMeeting(runtime, {
      agentId: "support",
      url: urlWithPasscode("old"),
    });

    const replacement = await joinMeeting(runtime, {
      agentId: "main",
      url: urlWithPasscode("correct"),
    });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.agentId).toBe("main");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(browserRequests(harness, "/tabs/open")).toHaveLength(2);
  });
});
