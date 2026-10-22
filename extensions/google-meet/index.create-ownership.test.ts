import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { createRequireRecord, useMeetingTestState } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { MEET_URL, MEET_URL_EN } from "./src/test-support/fixtures.test-helpers.js";
import {
  createGoogleMeetToolGatewayForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";

let meetingTestState: ReturnType<typeof useMeetingTestState>;

vi.mock("./src/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/runtime.js")>();
  return {
    ...actual,
    GoogleMeetRuntime: class extends actual.GoogleMeetRuntime {
      constructor(...args: ConstructorParameters<typeof actual.GoogleMeetRuntime>) {
        super(...args);
        meetingTestState.track(this, {
          readWarnings: () => vi.mocked(args[0].logger.warn).mock.calls,
        });
      }
    },
  };
});

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

describe("registered Google Meet create tab ownership", () => {
  meetingTestState = useMeetingTestState(createOpenClawTestState);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { owner: "plugin", preexisting: false },
    { owner: "user", preexisting: true },
  ])("preserves $owner tab ownership through create and leave", async ({ preexisting }) => {
    const targetId = "created-meet-tab";
    const tabs = new Map<string, { targetId: string; title: string; url: string }>();
    if (preexisting) {
      tabs.set(targetId, { targetId, title: "Meet", url: MEET_URL_EN });
    }
    const opened: string[] = [];
    const closed: string[] = [];
    const harness = setupGoogleMeetPlugin(
      plugin,
      { defaultMode: "transcribe", defaultTransport: "chrome-node" },
      {
        fullConfig: { transcripts: { enabled: false } },
        nodesInvokeHandler: async ({ command, params }) => {
          if (command === "googlemeet.chrome") {
            return { payload: { launched: true } };
          }
          if (command !== "browser.proxy") {
            throw new Error(`Unexpected node command: ${command}`);
          }
          const request = requireRecord(params, "browser request");
          const reply = (result: unknown) => ({ payload: { result } });
          if (request.path === "/tabs") {
            return reply({ running: true, tabs: [...tabs.values()] });
          }
          if (request.path === "/tabs/open") {
            const body = requireRecord(request.body, "open request");
            expect(body.url).toBe("https://meet.google.com/new?hl=en");
            opened.push(targetId);
            const tab = { targetId, title: "Meet", url: String(body.url) };
            tabs.set(targetId, tab);
            return reply(tab);
          }
          if (request.path === "/tabs/focus") {
            return reply({ ok: true });
          }
          if (request.path === `/tabs/${targetId}` && request.method === "DELETE") {
            closed.push(targetId);
            tabs.delete(targetId);
            return reply({ ok: true });
          }
          if (request.path === "/act") {
            const body = requireRecord(request.body, "evaluate request");
            expect(body.targetId).toBe(targetId);
            if (typeof body.fn === "string" && body.fn.includes("meetUrlPattern")) {
              tabs.set(targetId, { targetId, title: "Meet", url: MEET_URL_EN });
              return reply({
                ok: true,
                targetId,
                result: { meetingUri: MEET_URL, browserUrl: MEET_URL_EN, browserTitle: "Meet" },
              });
            }
            return reply({
              ok: true,
              targetId,
              result: JSON.stringify({
                inCall: true,
                micMuted: true,
                url: MEET_URL_EN,
                title: "Meet",
                lines: [],
                pendingLines: [],
                droppedLines: 0,
                urlMatched: true,
                sessionMatched: true,
                departed: true,
              }),
            });
          }
          throw new Error(`Unexpected browser request: ${String(request.path)}`);
        },
      },
    );
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(
      createGoogleMeetToolGatewayForTest(harness.methods),
    );
    const tool = harness.tools[0];
    if (!tool) {
      throw new Error("Expected Google Meet tool");
    }
    const created = requireRecord(
      (await tool.execute("create", { action: "create" })).details,
      "created meeting",
    );
    expect(created.joined).toBe(true);
    expect(created.meetingUri).toBe(MEET_URL);
    const join = requireRecord(created.join, "join result");
    const session = requireRecord(join.session, "meeting session");
    const left = requireRecord(
      (await tool.execute("leave", { action: "leave", sessionId: session.id })).details,
      "leave result",
    );
    expect(left.error).toBeUndefined();
    expect(opened).toEqual(preexisting ? [] : [targetId]);
    expect(closed).toEqual(preexisting ? [] : [targetId]);
    expect(tabs.has(targetId)).toBe(preexisting);
  });
});
