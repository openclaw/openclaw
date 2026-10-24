import { wrapPromptDataBlock } from "openclaw/plugin-sdk/qa-runtime";
import { extractToolPayload as extractQaToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, expect, it, vi } from "vitest";
import { nestedToolActivityFixture } from "../test/nested-tool-activity-fixture.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { findSubagentHandoffReply } from "./subagent-handoff-reply.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import { projectQaToolActivity } from "./tool-activity.js";

const child = {
  status: "accepted",
  childSessionKey: "agent:qa:subagent:child",
  runId: "child-run",
};
const requester = "agent:qa:handoff:this-handoff";
function forRequester<Args extends unknown[], Result>(run: (...args: Args) => Result) {
  return (_env: unknown, session: string | { sessionKey: string }, ...args: Args) => {
    expect(typeof session === "string" ? session : session.sessionKey).toBe(requester);
    return run(...args);
  };
}
function messageEvent(id: string, parentId: string, message: unknown) {
  return { type: "message", id, parentId, message };
}
afterEach(() => vi.useRealTimers());

async function runHandoff({
  fault,
  childReply = "qa-sidecar",
  deliveredReply = childReply,
  api,
}: {
  fault?: string;
  childReply?: string;
  deliveredReply?: string;
  api?: Record<string, unknown>;
} = {}) {
  const hasFault = (name: string) => fault === name;
  const result = hasFault("partial result")
    ? childReply + " was mentioned"
    : hasFault("result under evidence")
      ? "No result"
      : deliveredReply;
  const evidence = hasFault("result under evidence")
    ? "expected " + childReply
    : "Workspace check.";
  const reply = {
    role: "assistant",
    __openclaw: { id: "report" },
    content: `Delegated task:\n- Check the fixture.\nResult:\n- ${result}\nEvidence:\n- ${evidence}`,
  };
  // The task label matches the usual answer even when the delivered result differs.
  const secondResult = hasFault("answer only in second child");
  const delivered =
    secondResult || hasFault("answer only in task") ? "A different result" : childReply;
  const childResult = (text: string) =>
    wrapPromptDataBlock({ label: "Child result", text, encoding: "verbatim" });
  const settlement = [
    wrapPromptDataBlock({ label: "1. Child task", text: "qa-sidecar" }),
    "status: ok",
    childResult(delivered),
    ...(secondResult ? ["status: ok", childResult(childReply)] : []),
  ].join("\n");
  const delivery = messageEvent("delivery", "request", {
    role: "user",
    content: hasFault("private announcement") ? "Continue the OpenClaw runtime event." : settlement,
    provenance: {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: hasFault("private announcement") ? "subagent_announce" : "subagent_settle",
      sourceSessionKey: hasFault("another child's delivery")
        ? "another-child"
        : child.childSessionKey,
    },
  });
  const report = messageEvent("report", hasFault("other branch") ? "request" : delivery.id, reply);
  return runLoadedScenarioFlow("subagent-handoff", {
    api: {
      randomUUID: () => "this-handoff",
      startAgentRun: forRequester(async () => ({ runId: "parent-run" })),
      extractQaToolPayload,
      readSessionToolActivity: forRequester(async () =>
        projectQaToolActivity([
          nestedToolActivityFixture({
            toolName: "sessions_spawn",
            toolCallId: "spawn-call",
            input: { task: "Check the fixture" },
            text: JSON.stringify(hasFault("forbidden") ? { status: "forbidden" } : child),
          }),
        ]),
      ),
      waitForAgentRun: async (_env: unknown, runId: string) => {
        expect(runId).toBe(child.runId);
        return {
          runId: hasFault("another run") ? "other-run" : runId,
          status: hasFault("child failed") ? "error" : "ok",
          endedAt: 100,
          yielded: hasFault("child yielded"),
          terminalReply: {
            disposition: hasFault("silent terminal after progress") ? "silent" : "visible",
            text: childReply,
          },
        };
      },
      readSubagentHandoffReply: forRequester(
        async (childKey: string, text: string, messages: unknown[]) => {
          expect(childKey).toBe(child.childSessionKey);
          const events = hasFault("parent guessed before completion")
            ? [{ ...report, parentId: "request" }, delivery]
            : [delivery, report];
          return findSubagentHandoffReply(messages, childKey, text, async () => events);
        },
      ),
      waitForAgentHistory: forRequester(
        async (select: (history: { messages: unknown[] }) => Promise<string | undefined>) => {
          const visible = hasFault("unrelated public reply")
            ? { ...reply, __openclaw: { id: "another-report" } }
            : reply;
          const selected = await select({ messages: [visible] });
          if (!selected) {
            throw new Error("no matching delivered reply");
          }
          expect(selected).toBe(reply.content);
          return selected;
        },
      ),
      ...api,
    },
  });
}

// The yielded requester sees the child's own characters, so a faithful quote matches.
it.each([
  ["qa-sidecar", "qa-sidecar"],
  ["Verified 2 < 3.\nEvidence:\nCheck passed.", "Verified 2 < 3.\nEvidence:\nCheck passed."],
  ["column A\tcolumn B\r\n2 < 3", "column A\tcolumn B\n2 < 3"],
  ["literal &lt; stays &lt;", "literal &lt; stays &lt;"],
])(
  "credits the child's settled result in the requester's visible reply: %s",
  async (childReply, deliveredReply) => {
    expect((await runHandoff({ childReply, deliveredReply })).status).toBe("pass");
  },
);
it("does not credit a reply that HTML-escaped the child's result", async () => {
  await expect(
    runHandoff({ childReply: "Verified 2 < 3.", deliveredReply: "Verified 2 &lt; 3." }),
  ).rejects.toThrow("no matching delivered reply");
});

it.each([
  ["forbidden", "did not return an accepted child"],
  ...["another run", "child failed", "child yielded", "silent terminal after progress"].map(
    (fault) => [fault, "visible terminal reply"],
  ),
  ...[
    "parent guessed before completion",
    "partial result",
    "result under evidence",
    "another child's delivery",
    "other branch",
    "answer only in task",
    "answer only in second child",
    "private announcement",
    "unrelated public reply",
  ].map((fault) => [fault, "no matching delivered reply"]),
])("refuses %s", async (fault, error) => {
  await expect(runHandoff({ fault })).rejects.toThrow(error);
});

it.each([
  ["waitForCondition", "observes an accepted child run"],
  ["waitForAgentRun", "observes the accepted child's terminal reply"],
  ["waitForAgentHistory", "observes the child's result in the requester's reply"],
])("reports which observation expired at %s", async (wait, name) => {
  const details = "timed out after 360000ms";
  vi.useFakeTimers();
  // Let the preceding observations succeed, then expire only the selected wait.
  const pending = runHandoff({
    api: {
      runScenario: runQaSuiteScenarioSteps,
      [wait]: () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(details)), 360_000);
        }),
    },
  });
  await vi.advanceTimersByTimeAsync(360_000);
  const result = await pending;
  expect(result.status).toBe("fail");
  expect(result.steps.at(-1)).toMatchObject({ name, status: "fail", details });
});
