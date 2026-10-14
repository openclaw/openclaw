import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test } from "vitest";
import {
  getActiveBackgroundExecSessionCount,
  listFinishedSessions,
  waitForExecScope,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(resetProcessRegistryForTests);

test("real completed background commands retain only the newest fully readable process logs", async () => {
  const scopeKey = "agent:main:retention-proof";
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: true,
    backgroundMs: 0,
    scopeKey,
  });
  const processTool = createProcessTool({ scopeKey });
  const call = (action: string, sessionId?: string) =>
    processTool.execute(action, { action, sessionId });
  const sessionIds: string[] = [];

  for (let index = 0; index < 53; index += 1) {
    const result = await exec.execute(`background-retention-${index}`, {
      command: `node -e "process.stdout.write('retention-${index}')"`,
      background: true,
    });
    const details = result.details as { sessionId?: string; status?: string };
    expect(details.status).toBe("running");
    expect(details.sessionId).toEqual(expect.any(String));
    sessionIds.push(expectDefined(details.sessionId, "background session"));
  }

  await waitForExecScope(scopeKey);
  expect(getActiveBackgroundExecSessionCount()).toBe(0);

  const finishedSessions = listFinishedSessions();
  const listed = await call("list");
  expect((listed.details as { sessions?: unknown[] }).sessions).toHaveLength(50);

  // Real children can exit in a different order than their spawn calls; the
  // retention contract evicts by completion, not by launch position.
  const retainedSessionIds = new Set(finishedSessions.map((session) => session.id));
  const evictedSessionIds = sessionIds.filter((sessionId) => !retainedSessionIds.has(sessionId));
  expect(evictedSessionIds).toHaveLength(3);
  const evictedId = expectDefined(evictedSessionIds[0], "evicted process");
  const evicted = await call("poll", evictedId);
  expect(evicted.details).toMatchObject({ status: "failed" });
  expect(evicted.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(`No session found for ${evictedId}`),
  });

  const newestId = expectDefined(finishedSessions.at(-1)?.id, "newest completed process");
  const newestIndex = sessionIds.indexOf(newestId);
  const newestLog = await call("log", newestId);
  expect(newestLog.details).toMatchObject({ status: "completed" });
  expect(newestLog.content[0]).toMatchObject({
    type: "text",
    text: `retention-${newestIndex}`,
  });
}, 30_000);
