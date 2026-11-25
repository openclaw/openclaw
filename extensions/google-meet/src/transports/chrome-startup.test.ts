import { PassThrough } from "node:stream";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createMeetingNodeBrowserFixture } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import {
  MEET_URL,
  MEET_URL_EN,
  meetBrowserState,
  testBridgeProcess,
} from "../test-support/fixtures.test-helpers.js";
import { launchChromeMeet, launchChromeMeetOnNode } from "./chrome.js";

type NodeCall = { command: string; params: { action: string; bridgeId?: string } };
const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: processes.spawn,
}));

beforeEach(() => vi.spyOn(process, "platform", "get").mockReturnValue("darwin"));
afterEach(() => vi.restoreAllMocks());

it("retains required commands on local command-pair handles", () => {
  type Bridge = Extract<
    NonNullable<Awaited<ReturnType<typeof launchChromeMeet>>["audioBridge"]>,
    { type: "command-pair" }
  >;
  expectTypeOf<Bridge["inputCommand"]>().toEqualTypeOf<string[]>();
  expectTypeOf<Bridge["outputCommand"]>().toEqualTypeOf<string[]>();
});

it.each([
  ["chrome", "opened", "managed"],
  ["chrome", "reused", "configured"],
  ["chrome", "launch-disabled", "managed"],
  ["chrome-node", "opened", "configured"],
  ["chrome-node", "reused", "managed"],
  ["chrome-node", "launch-disabled", "configured"],
] as const)(
  "reclaims %s audio with an %s tab and %s input after failed startup",
  async (transport, ownership, inputSource) => {
    const local = transport === "chrome";
    const managed = inputSource === "managed";
    const events: string[] = [];
    const children: ReturnType<typeof testBridgeProcess>[] = [];
    const fixture = createMeetingNodeBrowserFixture({
      nodeCommand: "googlemeet.chrome",
      url: MEET_URL_EN,
      tabId: "owned-tab",
      title: "Meet",
      tabOpen: ownership !== "opened",
      status: () => meetBrowserState({ url: MEET_URL_EN }),
    });
    processes.spawn.mockImplementation((command: string) => {
      events.push(`spawn:${command}`);
      const child = testBridgeProcess({ stdin: new PassThrough(), stdout: new PassThrough() });
      const kill = child.kill.getMockImplementation()!;
      child.kill.mockImplementation((signal?: NodeJS.Signals) => {
        events.push(`kill:${command}`);
        return kill(signal);
      });
      children.push(child);
      return child;
    });
    const browser = async (request: Record<string, unknown>) => {
      events.push(`browser:${String(request.path)}`);
      return fixture.browserResult(request);
    };
    const nodeInvoke = fixture.invoke.getMockImplementation()!;
    const runtime = {
      gateway: {
        isAvailable: async () => true,
        request: async (_method: string, params: { path: string }) => browser(params),
      },
      nodes: {
        ...fixture.runtime.nodes,
        invoke: async ({ command, params }: NodeCall) => {
          if (command === "browser.proxy") {
            return { payload: { result: await browser(params) } };
          }
          events.push(["node", params.action, params.bridgeId].filter(Boolean).join(":"));
          return nodeInvoke({ command, params });
        },
      },
      system: {
        runCommandWithTimeout: async () => ({ code: 0, stdout: "BlackHole 2ch", stderr: "" }),
      },
    } as unknown as PluginRuntime;
    const config = resolveGoogleMeetConfig({
      chrome: {
        ...(!managed ? { audioInputCommand: ["capture"] } : {}),
        audioOutputCommand: ["play"],
        waitForInCallMs: 1,
        launch: ownership !== "launch-disabled",
      },
      realtime: { voiceProvider: "missing-meeting-test-provider" },
    });
    const launch = local ? launchChromeMeet : launchChromeMeetOnNode;
    await expect(
      launch({
        runtime,
        config,
        fullConfig: { plugins: { enabled: false } },
        mode: "bidi",
        meetingSessionId: "startup-owner",
        url: MEET_URL,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      }),
    ).rejects.toThrow(/provider/i);

    const captures = fixture.state.audioCaptureEvents;
    expect(captures.map((line) => line.action)).toEqual(managed ? ["start", "stop"] : []);
    expect(captures.map((line) => line.captureId)).toEqual(
      managed ? [expect.any(String), captures[0]?.captureId] : [],
    );
    expect(fixture.state.audioCaptureId).toBeUndefined();

    if (!local) {
      expect(events).toContain("node:stop:bridge-1");
    }
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
    expect(events.includes("browser:/tabs/owned-tab")).toBe(ownership === "opened");
    if (ownership === "opened") {
      const cleanupIndex = events.findIndex(
        (event) => event.startsWith("kill:") || event === "node:stop:bridge-1",
      );
      expect(cleanupIndex).toBeGreaterThan(-1);
      expect(cleanupIndex).toBeLessThan(events.lastIndexOf("browser:/tabs"));
    }
    expect(events.indexOf("browser:/act")).toBeLessThan(
      events.indexOf(local ? "spawn:play" : "node:start"),
    );
  },
);
