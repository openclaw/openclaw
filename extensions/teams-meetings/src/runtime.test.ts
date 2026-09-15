import {
  createMeetingBrowserFixture,
  defineMeetingSessionFlowTests,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
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

function runtimeHarness(url: string, options?: { tabOpen?: boolean }) {
  return createMeetingBrowserFixture({
    url,
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
    url?: string;
    config?: Parameters<typeof resolveTeamsMeetingsConfig>[0];
    harness?: { tabOpen?: boolean };
    fullConfig?: ConstructorParameters<typeof TeamsMeetingsRuntime>[0]["fullConfig"];
  } = {},
) {
  const harness = runtimeHarness(options.url ?? URL, options.harness);
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

describe("Microsoft Teams short-link session flow", () => {
  const url = "https://teams.microsoft.com/meet/1234567890123?p=Synthetic-runtime-token";
  it("joins, reuses with tracking, reports, reads captions, and safely leaves through core", async () => {
    const { runtime } = runtimeFixture({ url });
    const first = await runtime.join({ url, mode: "transcribe" });
    const reused = await runtime.join({ url: url + "&tracking=two", mode: "transcribe" });
    expect(reused.session.id).toBe(first.session.id);
    expect(runtime.list()).toHaveLength(1);
    expect(await runtime.status(first.session.id)).toMatchObject({ found: true });
    expect(await runtime.transcript(first.session.id)).toMatchObject({ found: true, lines: [] });
    expect(await runtime.speak(first.session.id, "Synthetic test")).toMatchObject({
      spoken: false,
    });
    expect(await runtime.leave(first.session.id)).toMatchObject({ found: true, browserLeft: true });
  });
  it("does not reuse a session for a different opaque passcode", async () => {
    const { runtime } = runtimeFixture({ url });
    const first = await runtime.join({ url, mode: "transcribe" });
    const second = await runtime.join({
      url: url.replace("Synthetic-runtime-token", "Different-runtime-token"),
      mode: "transcribe",
    });
    expect(second.session.id).not.toBe(first.session.id);
    await runtime.leave(first.session.id);
    await runtime.leave(second.session.id);
  });
  it("recovers the tracked short-link tab after a same-origin in-call rewrite", async () => {
    const { runtime, harness } = runtimeFixture({ url });
    const joined = await runtime.join({ url, mode: "transcribe" });
    harness.state.tabUrl = "https://teams.microsoft.com/v2/";
    harness.gatewayRequest.mockClear();
    const status = await runtime.status(joined.session.id);
    expect(status.session?.chrome?.health?.browserUrl).toBe(harness.state.tabUrl);
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: "teams-tab" }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
    await runtime.leave(joined.session.id);
  });
});
