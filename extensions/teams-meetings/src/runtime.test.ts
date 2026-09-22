import {
  createMeetingBrowserFixture,
  defineMeetingSessionFlowTests,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, vi } from "vitest";
import { teamsMeetingsConfig } from "./config.js";
import { TeamsMeetingsRuntime } from "./runtime.js";

const resolveTeamsMeetingsConfig = teamsMeetingsConfig.resolveConfig;

const URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_runtime%40thread.v2/0?context=%7b%22Tid%22%3a%22one%22%7d";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function runtimeHarness(options?: { tabOpen?: boolean }) {
  return createMeetingBrowserFixture({
    url: URL,
    tabId: "teams-tab",
    title: "Teams call",
    leaveSessionMatched: true,
    followOpenedUrl: false,
    ...options,
    status: (state, script) => ({
      inCall: true,
      micMuted: true,
      cameraOff: true,
      ...(state.sessionConflict && script.includes("const allowSessionAdoption = false")
        ? {
            manualAction: {
              reason: "teams-session-conflict",
              message: "This Teams tab is owned by another active meeting session.",
            },
          }
        : {}),
      url: state.tabUrl,
      title: "Teams call",
    }),
  });
}

function runtimeFixture(
  options: {
    config?: Parameters<typeof resolveTeamsMeetingsConfig>[0];
    harness?: { tabOpen?: boolean };
    fullConfig?: ConstructorParameters<typeof TeamsMeetingsRuntime>[0]["fullConfig"];
  } = {},
) {
  const harness = runtimeHarness(options.harness);
  const runtime = new TeamsMeetingsRuntime({
    config: resolveTeamsMeetingsConfig(
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

describe("Microsoft Teams meeting session flow", () => {
  defineMeetingSessionFlowTests({
    createFixture: runtimeFixture,
    url: URL,
    tabId: "teams-tab",
    rewrittenUrl: "https://teams.microsoft.com/v2/",
    rewrittenUrlTestName: "recovers the tracked tab after Teams rewrites the in-call URL",
    endedHealth: {},
  });
});
