import { PassThrough } from "node:stream";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { MEET_URL, MEET_URL_EN, testBridgeProcess } from "../test-support/fixtures.test-helpers.js";
import { launchChromeMeet, launchChromeMeetOnNode } from "./chrome.js";

const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: processes.spawn,
}));

describe("Google Meet startup ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });
  afterEach(() => vi.restoreAllMocks());

  it("retains required commands on local command-pair handles", () => {
    type Bridge = Extract<
      NonNullable<Awaited<ReturnType<typeof launchChromeMeet>>["audioBridge"]>,
      { type: "command-pair" }
    >;
    expectTypeOf<Bridge["inputCommand"]>().toEqualTypeOf<string[]>();
    expectTypeOf<Bridge["outputCommand"]>().toEqualTypeOf<string[]>();
  });

  it.each(
    (["chrome", "chrome-node"] as const).flatMap((transport) =>
      (["opened", "reused", "launch-disabled"] as const).map((ownership) => ({
        transport,
        ownership,
      })),
    ),
  )(
    "reclaims $transport audio after failed startup with an $ownership tab",
    async ({ transport, ownership }) => {
      const events: string[] = [];
      const children: ReturnType<typeof testBridgeProcess>[] = [];
      const nodeStops: Array<{ action: string; bridgeId?: string }> = [];
      const tab = { targetId: "owned-tab", title: "Meet", url: MEET_URL_EN };
      let tabExists = ownership !== "opened";
      let inspections = 0;
      processes.spawn.mockImplementation((command: string) => {
        events.push(`spawn:${command}`);
        const child = testBridgeProcess({ stdin: new PassThrough(), stdout: new PassThrough() });
        child.kill.mockImplementation((signal?: NodeJS.Signals) => {
          events.push(`kill:${command}`);
          child.killed = true;
          child.signalCode = signal ?? "SIGTERM";
          child.emit("exit", null, child.signalCode);
          child.emit("close", null, child.signalCode);
          return true;
        });
        children.push(child);
        return child;
      });
      const browser = async (request: { path: string }) => {
        events.push(`browser:${request.path}`);
        if (request.path === "/tabs") {
          return { tabs: tabExists ? [tab] : [] };
        }
        if (request.path === "/tabs/open") {
          tabExists = true;
          return tab;
        }
        if (request.path === "/act") {
          if (inspections++ > 0) {
            return { result: JSON.stringify({ departed: true, urlMatched: true }) };
          }
          return {
            result: JSON.stringify({
              inCall: true,
              micMuted: false,
              audioInputRouted: true,
              audioOutputRouted: true,
              url: MEET_URL_EN,
            }),
          };
        }
        return { ok: true };
      };
      const runtime = {
        gateway: {
          isAvailable: async () => true,
          request: async (_method: string, params: { path: string }) => browser(params),
        },
        nodes: {
          list: async () => ({
            nodes: [
              {
                nodeId: "node-1",
                connected: true,
                commands: ["googlemeet.chrome", "browser.proxy"],
              },
            ],
          }),
          invoke: async ({
            command,
            params,
          }: {
            command: string;
            params: { action: string; path: string; bridgeId?: string };
          }) => {
            if (command === "browser.proxy") {
              return { payload: { result: await browser(params) } };
            }
            events.push(`node:${params.action}`);
            if (params.action === "stop") {
              nodeStops.push({ action: params.action, bridgeId: params.bridgeId });
            }
            return {
              payload:
                params.action === "start"
                  ? { bridgeId: "bridge-1", audioBridge: { type: "node-command-pair" } }
                  : {},
            };
          },
        },
        system: {
          runCommandWithTimeout: async () => {
            events.push("audio:prepare");
            return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
          },
        },
      } as unknown as PluginRuntime;
      const launch = transport === "chrome" ? launchChromeMeet : launchChromeMeetOnNode;
      await expect(
        launch({
          runtime,
          config: resolveGoogleMeetConfig({
            chrome: {
              audioInputCommand: ["capture"],
              audioOutputCommand: ["play"],
              waitForInCallMs: 1,
              launch: ownership !== "launch-disabled",
            },
            realtime: { voiceProvider: "missing-meeting-test-provider" },
          }),
          fullConfig: {},
          mode: "bidi",
          meetingSessionId: "startup-owner",
          url: MEET_URL,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        }),
      ).rejects.toThrow(/provider/i);

      expect(events.filter((event) => event.startsWith("node:"))).toEqual(
        transport === "chrome-node"
          ? ["node:stopByUrl", "node:setup", "node:start", "node:stop"]
          : [],
      );
      expect(nodeStops).toEqual(
        transport === "chrome-node" ? [{ action: "stop", bridgeId: "bridge-1" }] : [],
      );
      expect(events.filter((event) => event.startsWith("spawn:"))).toEqual(
        transport === "chrome" ? ["spawn:play", "spawn:capture"] : [],
      );
      expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
      expect(events.filter((event) => event === "browser:/tabs")).toHaveLength(
        ownership === "opened" ? 2 : 1,
      );
      expect(events.includes("browser:/tabs/owned-tab")).toBe(ownership === "opened");
      if (ownership === "opened") {
        const cleanupIndex = events.findIndex(
          (event) => event.startsWith("kill:") || event === "node:stop",
        );
        expect(cleanupIndex).toBeGreaterThan(-1);
        expect(cleanupIndex).toBeLessThan(events.lastIndexOf("browser:/tabs"));
      }
      expect(events.indexOf("browser:/act")).toBeLessThan(
        events.indexOf(transport === "chrome" ? "spawn:play" : "node:start"),
      );
    },
  );
});
