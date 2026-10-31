import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { MEET_URL, meetLaunchedTab } from "./src/test-support/fixtures.test-helpers.js";
import { setupParticipationHarness } from "./src/test-support/participation-harness.js";
import { getMeetTool } from "./src/test-support/plugin-harness.js";
import * as chromeTransport from "./src/transports/chrome.js";

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

const setupWithSqlite = (stateEnv: NodeJS.ProcessEnv) =>
  setupParticipationHarness(
    plugin,
    { defaultTransport: "chrome", defaultMode: "transcribe" },
    { stateEnv, fullConfig: { transcripts: { enabled: false } } },
  );

afterEach(() => vi.restoreAllMocks());

it("persists unsupported results and replays them without restoring ended session authority", () =>
  withOpenClawTestState(
    { label: "google-meet-participation-registration", applyEnv: false },
    async (state) => {
      const launched = meetLaunchedTab("participation-tab");
      const launch = vi.spyOn(chromeTransport, "launchChromeMeet").mockResolvedValue(launched);
      const leave = vi
        .spyOn(chromeTransport, "leaveChromeMeet")
        .mockResolvedValue({ left: true, note: "left" });
      vi.spyOn(chromeTransport, "readChromeMeetTranscript").mockResolvedValue({
        droppedLines: 0,
        lines: [],
      });
      const harness = setupWithSqlite(state.env);
      const tool = getMeetTool(harness);
      let sessionId: string | undefined;
      try {
        const joined = await tool.execute("join-call", { action: "join", url: MEET_URL });
        sessionId = joined.details.session.id;
        expect(joined.details.session.state).toBe("active");
        expect(launch).toHaveBeenCalledOnce();

        const contextRequest = { action: "participation_context", sessionId };
        const context = { sessionId, active: true, capabilities: [] };
        expect(await harness.execute(contextRequest)).toMatchObject(context);

        const request = {
          action: "participate",
          sessionId,
          requestId: "unsupported-reaction",
          participationAction: { type: "reaction", reaction: "👍" },
        };
        const firstResult = requireRecord(await harness.execute(request), "participation result");
        expect(firstResult).toMatchObject({ requestId: request.requestId, status: "unsupported" });

        const left = await tool.execute("leave-call", { action: "leave", sessionId });
        expect(left.details).toMatchObject({ found: true, browserLeft: true });
        expect(leave).toHaveBeenCalledOnce();
        const expectEnded = async (owner: typeof harness, requestId: string) => {
          expect(await owner.execute(contextRequest)).toMatchObject({ ...context, active: false });
          expect(await owner.execute(request)).toEqual({ ...firstResult, replayed: true });
          expect(await owner.execute({ ...request, requestId })).toMatchObject({
            status: "rejected",
          });
          expect(owner.nodesInvoke).not.toHaveBeenCalled();
        };
        await expectEnded(harness, "request-after-leave");
        expect(harness.runCommandWithTimeout).not.toHaveBeenCalled();

        // Reopen SQLite and the runtime: replay must survive both owners.
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
        const restarted = setupWithSqlite(state.env);
        await expectEnded(restarted, "request-after-restart");
        expect(launch).toHaveBeenCalledOnce();
        expect(leave).toHaveBeenCalledOnce();
      } finally {
        if (sessionId) {
          await harness.gatewayRequest("googlemeet.leave", { sessionId });
        }
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    },
  ));
