import { afterEach, expect, it } from "vitest";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { maybeNotifyOnExit } from "./bash-tools.exec-notify.js";

afterEach(() => resetSystemEventsForTest());

it("keeps a hidden-subagent completion on process poll when the session queue is full", async () => {
  const sessionKey = "agent:main:subagent:queue-full";
  for (let index = 0; index < 20; index++) {
    enqueueSystemEvent(`Exec completed ${index}`, { sessionKey, contextKey: `exec:${index}` });
  }
  const process = createProcessSessionFixture({ id: "queue-full", backgrounded: true });
  Object.assign(process, { sessionKey, notifyOnExit: true, exitCode: 1 });

  await expect(maybeNotifyOnExit(process, "failed", true)).resolves.toBeUndefined();
  expect(peekSystemEvents(sessionKey)).toHaveLength(20);
  expect(process.notifyOnExitRemoval).toBeUndefined();
});
