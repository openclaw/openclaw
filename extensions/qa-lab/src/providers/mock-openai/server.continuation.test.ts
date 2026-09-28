import { describe, expect, it } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { runScenarioFlow } from "../../scenario-flow-runner.js";
import { runQaSuiteScenarioSteps } from "../../suite-runtime-flow.js";
import { makeQaSuiteTestScenario } from "../../suite-test-helpers.js";
import type { QaMockContinuationHold } from "./mock-openai-request-log.js";
import {
  createMockServerTestHarness,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputToolCall,
  postJson,
} from "./server.test-harness.js";

const { startMockServer, cleanups } = createMockServerTestHarness();

describe("QA held continuation", () => {
  it("lets a maintained flow hold one exact session continuation before its response", async () => {
    const server = await startMockServer();
    const controller = new AbortController();
    const sessionId = "held-session";
    const input = [makeUserInput("Inspect the repo kickoff task.")];
    const post = (items: unknown[], id = sessionId) =>
      postJson(server, "/v1/responses", { input: items }, { session_id: id });
    const initial = await post(input);
    const call = outputToolCall(await initial.json(), "read");
    if (typeof call.call_id !== "string") {
      throw new Error("provider omitted tool-call identity");
    }
    const vars: Record<string, QaMockContinuationHold> = {};
    try {
      const result = await runScenarioFlow({
        api: {
          env: { mock: server },
          signal: controller.signal,
          state: createQaBusState(),
          scenario: makeQaSuiteTestScenario("held-continuation"),
          config: {},
          runScenario: runQaSuiteScenarioSteps,
        },
        scenarioTitle: "held continuation",
        vars,
        flow: {
          steps: [
            {
              name: "arm",
              actions: [
                {
                  call: "env.mock.holdNextContinuation",
                  args: [sessionId, { expr: "signal" }],
                  saveAs: "hold",
                },
              ],
            },
          ],
        },
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "pass",
        steps: [{ status: "pass" }],
      });
      const hold = vars.hold;
      if (!hold) {
        throw new Error("scenario did not return its continuation hold");
      }
      const continuation = [...input, call, makeToolOutputWithCallId(call.call_id, "done")];
      // An initial request and another session's continuation must not consume the hold.
      expect((await post([makeUserInput("Reply exactly: INITIAL-OK")])).status).toBe(200);
      expect((await post(continuation, "other-session")).status).toBe(200);
      const summary = await postJson(server, "/v1/responses", {
        client_metadata: { session_id: sessionId },
        instructions:
          "You are a context summarization assistant. Produce a structured summary. Do not continue.",
        input: continuation,
      });
      expect(summary.status).toBe(200);
      let completed = false;
      const pending = post(continuation).then((response) => {
        completed = true;
        return response;
      });
      const checkpoint = await Promise.race([
        hold.reached,
        pending.then(() => {
          throw new Error("continuation responded before checkpoint");
        }),
      ]);
      expect(checkpoint).toEqual({ cursor: 5, sessionId, toolOutputCallId: call.call_id });
      expect(await getJson(server, "/debug/requests?after=4")).toMatchObject([
        { ...checkpoint, requestKind: "tool-continuation", toolOutput: "done" },
      ]);
      expect(completed).toBe(false);
      hold.release();
      expect((await pending).status).toBe(200);
      // The hold is one-shot; observing the same identity again proceeds naturally.
      expect((await post(continuation)).status).toBe(200);
    } finally {
      controller.abort();
    }
  });

  it("cancels an unreached hold without poisoning the next scenario", async () => {
    const server = await startMockServer();
    const controller = new AbortController();
    const first = server.holdNextContinuation("first-session", controller.signal);
    expect(() => first.release()).toThrow("has not reached");
    expect(() => server.holdNextContinuation("other-session", controller.signal)).toThrow(
      "idle hold",
    );
    controller.abort();
    await expect(first.reached).rejects.toThrow("hold aborted");
    const next = server.holdNextContinuation("next-session", new AbortController().signal);
    first.cancel();
    // A stale handle must not cancel the replacement hold; provider shutdown must.
    await cleanups.pop()?.();
    await expect(next.reached).rejects.toThrow("provider stopped");
    expect(() => server.holdNextContinuation("late-session", new AbortController().signal)).toThrow(
      "live provider",
    );
  });

  it.each(["cancel", "abort", "stop"] as const)(
    "settles a held HTTP dispatch on %s",
    async (action) => {
      const server = await startMockServer();
      const controller = new AbortController();
      const hold = server.holdNextContinuation("cleanup-session", controller.signal);
      const pending = postJson(server, "/v1/responses", {
        client_metadata: { session_id: "cleanup-session" },
        input: [
          makeUserInput("Reply exactly: DONE"),
          makeToolOutputWithCallId("cleanup-call", "done"),
        ],
      });
      await hold.reached;
      if (action === "cancel") {
        hold.cancel();
      } else if (action === "abort") {
        controller.abort();
      } else {
        await cleanups.pop()?.();
      }
      const response = await pending;
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("QA continuation");
    },
  );
});
