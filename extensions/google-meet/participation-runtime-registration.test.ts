import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
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
  const execute = async (params: Record<string, unknown>) =>
    (await tool.execute("participation-call", params)).details;
  return { ...harness, execute };
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

          const contextRequest = { action: "participation_context", sessionId };
          expect(await harness.execute(contextRequest)).toEqual({
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
          const firstResult = requireRecord(await harness.execute(request), "participation result");
          expect(firstResult).toMatchObject({
            requestId: request.requestId,
            status: "unsupported",
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
          const endedContext = {
            sessionId,
            active: false,
            sourceOrder: 0,
            capabilities: [],
            sources: [],
          };
          expect(await harness.execute(contextRequest)).toEqual(endedContext);
          expect(await harness.execute(request)).toEqual({
            ...firstResult,
            replayed: true,
          });
          expect(
            await harness.execute({ ...request, requestId: "request-after-leave" }),
          ).toMatchObject({ status: "rejected" });
          expect(harness.nodesInvoke).not.toHaveBeenCalled();
          expect(harness.runCommandWithTimeout).not.toHaveBeenCalled();

          // Close and reopen SQLite as well as constructing fresh plugin/runtime
          // owners: durable replay must not depend on the old runtime instance.
          await closeOpenClawStateDatabaseAsync();
          resetPluginStateStoreForTests();
          const restarted = setupWithSqlite(state.env);
          expect(await restarted.execute(contextRequest)).toEqual(endedContext);
          expect(await restarted.execute(request)).toEqual({
            ...firstResult,
            replayed: true,
          });
          expect(
            await restarted.execute({ ...request, requestId: "request-after-restart" }),
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
