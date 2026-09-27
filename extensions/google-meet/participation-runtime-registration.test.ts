import type { MeetingParticipationAttempt } from "openclaw/plugin-sdk/meeting-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { MEET_URL } from "./src/test-support/fixtures.test-helpers.js";
import {
  createGoogleMeetToolGatewayForTest,
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import * as chromeTransport from "./src/transports/chrome.js";
import { testing } from "./test-api.js";

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

// Only the browser transport is simulated. Registration, both meeting runtimes,
// current-session ownership, and the plugin's SQLite store run unchanged.
function setupWithSqlite(env: NodeJS.ProcessEnv) {
  const harness = setupGoogleMeetPlugin(
    plugin,
    { defaultTransport: "chrome", defaultMode: "transcribe" },
    { stateEnv: env, fullConfig: { transcripts: { enabled: false } } },
  );
  testing.setCallGatewayFromCliForTests(createGoogleMeetToolGatewayForTest(harness.methods));
  const tool = harness.tools[0];
  if (!tool) {
    throw new Error("Expected Google Meet tool registration");
  }
  return { ...harness, tool };
}

describe("Google Meet registered participation lifecycle", () => {
  afterEach(() => {
    testing.setCallGatewayFromCliForTests();
    vi.restoreAllMocks();
  });

  it("persists unsupported results and replays them without restoring ended session authority", async () => {
    await withOpenClawTestState(
      { label: "google-meet-participation-registration", applyEnv: false },
      async (state) => {
        const launch = vi.spyOn(chromeTransport, "launchChromeMeet").mockResolvedValue({
          launched: true,
          tab: { targetId: "participation-tab", openedByPlugin: true },
          browser: { inCall: true, micMuted: true },
        });
        const leave = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
          left: true,
          note: "Left the test meeting",
        });
        vi.spyOn(chromeTransport, "readChromeMeetTranscript").mockResolvedValue({
          droppedLines: 0,
          lines: [],
        });
        const harness = setupWithSqlite(state.env);
        let sessionId: string | undefined;
        try {
          const joined = await getMeetTool(harness).execute("join-call", {
            action: "join",
            url: MEET_URL,
          });
          sessionId = joined.details.session.id;
          expect(joined.details.session.state).toBe("active");
          expect(launch).toHaveBeenCalledOnce();

          const context = await harness.tool.execute("context-call", {
            action: "participation_context",
            sessionId,
          });
          expect(context.details).toEqual({
            sessionId,
            active: true,
            sourceOrder: 0,
            capabilities: [],
            sources: [],
          });

          const request = {
            action: "participate",
            sessionId,
            requestId: "unsupported-reaction",
            participationAction: { type: "reaction", reaction: "👍" },
          };
          const first = await harness.tool.execute("participate-call", request);
          const firstResult = requireRecord(first.details, "participation result");
          expect(firstResult).toMatchObject({
            requestId: request.requestId,
            status: "unsupported",
          });
          const ledger = createPluginStateKeyedStoreForTests<MeetingParticipationAttempt>(
            "google-meet",
            {
              namespace: "meeting-participation",
              maxEntries: 10_000,
              overflowPolicy: "reject-new",
              env: state.env,
            },
          );
          expect(await ledger.lookup(`${sessionId}:request:${request.requestId}`)).toMatchObject({
            requestId: request.requestId,
            actionType: "reaction",
            result: first.details,
          });

          const left = await getMeetTool(harness).execute("leave-call", {
            action: "leave",
            sessionId,
          });
          expect(left.details).toMatchObject({ found: true, browserLeft: true });
          expect(leave).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              meetingSessionId: sessionId,
              meetingUrl: MEET_URL,
              tab: { targetId: "participation-tab", openedByPlugin: true },
            }),
          );
          expect(
            (
              await harness.tool.execute("ended-context", {
                action: "participation_context",
                sessionId,
              })
            ).details,
          ).toEqual({ sessionId, active: false, sourceOrder: 0, capabilities: [], sources: [] });
          expect((await harness.tool.execute("same-result", request)).details).toEqual({
            ...firstResult,
            replayed: true,
          });
          expect(
            (
              await harness.tool.execute("new-request-after-leave", {
                ...request,
                requestId: "request-after-leave",
              })
            ).details,
          ).toMatchObject({ status: "rejected" });
          expect(harness.nodesInvoke).not.toHaveBeenCalled();
          expect(harness.runCommandWithTimeout).not.toHaveBeenCalled();

          // Close and reopen SQLite as well as constructing fresh plugin/runtime
          // owners: durable replay must not depend on the old runtime instance.
          await closeOpenClawStateDatabaseAsync();
          resetPluginStateStoreForTests();
          const restarted = setupWithSqlite(state.env);
          expect(
            (
              await restarted.tool.execute("restarted-context", {
                action: "participation_context",
                sessionId,
              })
            ).details,
          ).toEqual({ sessionId, active: false, sourceOrder: 0, capabilities: [], sources: [] });
          expect((await restarted.tool.execute("restarted-replay", request)).details).toEqual({
            ...firstResult,
            replayed: true,
          });
          expect(
            (
              await restarted.tool.execute("restarted-new-request", {
                ...request,
                requestId: "request-after-restart",
              })
            ).details,
          ).toMatchObject({ status: "rejected" });
          expect(launch).toHaveBeenCalledOnce();
          expect(leave).toHaveBeenCalledOnce();
          expect(restarted.nodesInvoke).not.toHaveBeenCalled();
        } finally {
          if (sessionId) {
            await invokeGoogleMeetGatewayMethodForTest(harness.methods, "googlemeet.leave", {
              sessionId,
            });
          }
          await closeOpenClawStateDatabaseAsync();
          resetPluginStateStoreForTests();
        }
      },
    );
  });
});
