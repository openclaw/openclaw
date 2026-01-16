import { afterEach, expect, test } from "vitest";

import { createExecTool } from "./bash-tools.exec";
import {
  getFinishedSession,
  getSession,
  resetProcessRegistryForTests,
} from "./bash-process-registry";
import { killProcessTree } from "./shell-utils";

afterEach(() => {
  resetProcessRegistryForTests();
});

test("background exec is not killed when tool signal aborts", async () => {
  const tool = createExecTool({ allowBackground: true, backgroundMs: 0 });
  const abortController = new AbortController();

  const result = await tool.execute(
    "toolcall",
    { command: 'node -e "setTimeout(() => {}, 5000)"', background: true },
    abortController.signal,
  );

  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  abortController.abort();

  await new Promise((resolve) => setTimeout(resolve, 150));

  const running = getSession(sessionId);
  const finished = getFinishedSession(sessionId);

  try {
    expect(finished).toBeUndefined();
    expect(running?.exited).toBe(false);
  } finally {
    const pid = running?.pid;
    if (pid) killProcessTree(pid);
  }
});
