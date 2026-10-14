import path from "node:path";
import { expect, it, vi } from "vitest";
import { CodexEventProjection } from "./event-projector-events.js";
import {
  createTestParams,
  createParams,
  tempDir,
  createStartedThreadHarness,
  createResumeHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

it("retries an unprojected policy warning on the next attempt, then stops replaying it", async () => {
  const harness = createStartedThreadHarness();
  const onAgentEvent = vi.fn();
  const params = { ...createTestParams(), onAgentEvent };
  const warning = {
    method: "configWarning",
    params: {
      summary:
        "Ignoring unknown `features` requirement `ultrafast_mode` from enterprise-managed requirements Example policy (example-policy)",
    },
  };
  const projectWarning = vi.spyOn(CodexEventProjection.prototype, "handleWarning");
  projectWarning.mockImplementationOnce(() => {
    throw new Error("synthetic warning projection failure");
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const run = runCodexAppServerAttempt({ ...params, runId: "warning-run-" + attempt });
    await run.waitForTurnAccepted();
    if (attempt === 0) {
      await harness.notify(warning);
    }
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(projectWarning).toHaveBeenNthCalledWith(1, warning.params);
    const notices = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "notice");
    expect(notices).toEqual(
      attempt === 0
        ? []
        : [
            {
              stream: "notice",
              data: { phase: "warning", message: warning.params.summary },
            },
          ],
    );
  }
});

it("shows one warning for a native burst and later client replacement in the same chat", async () => {
  const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
  const onAgentEvent = vi.fn();
  const params = createParams(
    path.join(tempDir, "warning-chat.jsonl"),
    path.join(tempDir, "workspace"),
    { provider: "openai" },
  );
  params.onAgentEvent = onAgentEvent;
  const message =
    "Ignoring unknown `features` requirement `ultrafast_mode` from enterprise-managed requirements Example policy (example-policy)";
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  for (let index = 0; index < 4; index++) {
    await harness.notify({ method: "configWarning", params: { summary: message } });
  }
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
  expect(
    onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "notice"),
  ).toEqual([{ stream: "notice", data: { phase: "warning", message } }]);

  harness.close();
  const replacement = createResumeHarness("thread-1");
  const next = runCodexAppServerAttempt({ ...params, runId: "after-reconnect" });
  await next.waitForTurnAccepted();
  await Promise.all(
    Array.from({ length: 4 }, () =>
      replacement.notify({
        method: "warning",
        params: { threadId: "thread-1", message },
      }),
    ),
  );
  await replacement.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await next;
  expect(replacement.requests.some(({ method }) => method === "thread/resume")).toBe(true);
  expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "notice")).toHaveLength(1);
});
