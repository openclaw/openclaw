import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runPluginAsyncCallbackCommand } from "./plugin-async-callback.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => closeOpenClawStateDatabaseAsync());

it("serializes concurrent issuance for one outstanding child callback", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("plugin-callback-capacity-") };
  const database = openOpenClawStateDatabase({ env });
  const context = captureOpenClawStateWorkerContext({ env });
  const binding = {
    pluginId: "fixture",
    toolName: "render",
    childSessionKey: "agent:main:subagent:capacity",
    childSessionId: "capacity-session",
    childRunId: "capacity-run",
    childCreatedAt: 1,
  };
  const outcomes = await Promise.allSettled(
    ["fixture", "other"].map((pluginId) =>
      runPluginAsyncCallbackCommand(
        {
          type: "pluginCallback.issue",
          input: { binding: { ...binding, pluginId }, ttlMs: 60_000 },
        },
        () => {},
        context,
      ),
    ),
  );
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  expect(
    database.db
      .prepare(
        "SELECT count(*) AS count FROM delivery_queue_entries WHERE queue_name = 'session-native-child'",
      )
      .get(),
  ).toMatchObject({ count: 1 });
});

it("runs the registered SQLite worker command with exact capability and atomic delivery", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("plugin-callback-worker-") };
  const database = openOpenClawStateDatabase({ env });
  const context = captureOpenClawStateWorkerContext({ env });
  const binding = {
    pluginId: "fixture",
    toolName: "render",
    childSessionKey: "agent:main:subagent:fixture",
    childSessionId: "fixture-session",
    childRunId: "fixture-run",
    childCreatedAt: 1,
  };
  let live = true;
  const guard = () => {
    if (!live) {
      throw new Error("child no longer current");
    }
  };
  const issued = await runPluginAsyncCallbackCommand(
    { type: "pluginCallback.issue", input: { binding, ttlMs: 60_000 } },
    guard,
    context,
  );
  const command = {
    type: "pluginCallback.complete" as const,
    input: { binding, token: issued.token, resultText: "result" },
  };
  const accepted = await runPluginAsyncCallbackCommand(command, guard, context);
  expect(accepted.status).toBe("accepted");
  expect(await runPluginAsyncCallbackCommand(command, guard, context)).toEqual({
    status: "duplicate",
    queueId: accepted.status === "accepted" ? accepted.queueId : "",
  });
  expect(
    database.db
      .prepare(
        "SELECT count(*) AS count FROM delivery_queue_entries WHERE queue_name = 'session-native-child'",
      )
      .get(),
  ).toMatchObject({ count: 2 });
  live = false;
  await expect(runPluginAsyncCallbackCommand(command, guard, context)).rejects.toThrow(
    "child no longer current",
  );
});
