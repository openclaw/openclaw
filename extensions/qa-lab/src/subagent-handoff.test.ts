import { wrapPromptDataBlock } from "openclaw/plugin-sdk/qa-runtime";
import { extractToolPayload as extractQaToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { expect, it, vi } from "vitest";
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
  const result =
    fault === "partial result"
      ? childReply + " was mentioned"
      : fault === "result under evidence"
        ? "No result"
        : deliveredReply;
  const evidence =
    fault === "result under evidence" ? "expected " + childReply : "Workspace check.";
  const reply = {
    role: "assistant",
    __openclaw: { id: "report" },
    content: `Delegated task:\n- Check the fixture.\nResult:\n- ${result}\nEvidence:\n- ${evidence}`,
  };
  // Same field boundaries as subagent-announce.requester-settle-results.test.ts.
  // The task label deliberately equals the usual answer, even when the delivered result differs.
  const secondResult = fault === "answer only in second child";
  const delivered =
    secondResult || fault === "answer only in task" ? "A different result" : childReply;
  const childResult = (text: string) => wrapPromptDataBlock({ label: "Child result", text });
  const settlement = [
    wrapPromptDataBlock({ label: "1. Child task", text: "qa-sidecar" }),
    "status: ok",
    childResult(delivered),
    ...(secondResult ? ["status: ok", childResult(childReply)] : []),
  ].join("\n");
  const delivery = {
    type: "message",
    id: "delivery",
    parentId: "request",
    message: {
      role: "user",
      content:
        fault === "private announcement" ? "Continue the OpenClaw runtime event." : settlement,
      provenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: fault === "private announcement" ? "subagent_announce" : "subagent_settle",
        sourceSessionKey:
          fault === "another child's delivery" ? "another-child" : child.childSessionKey,
      },
    },
  };
  const report = {
    type: "message",
    id: "report",
    parentId: fault === "other branch" ? "request" : delivery.id,
    message: reply,
  };
  const requester = "agent:qa:handoff:this-handoff";
  return runLoadedScenarioFlow("subagent-handoff", {
    api: {
      randomUUID: () => "this-handoff",
      startAgentRun: async (_env: unknown, { sessionKey }: { sessionKey: string }) => {
        expect(sessionKey).toBe(requester);
        return { runId: "parent-run" };
      },
      extractQaToolPayload,
      readSessionToolActivity: async (_env: unknown, sessionKey: string) => {
        expect(sessionKey).toBe(requester);
        const receipt = fault === "forbidden" ? { status: "forbidden" } : child;
        return projectQaToolActivity([
          nestedToolActivityFixture({
            toolName: "sessions_spawn",
            toolCallId: "spawn-call",
            input: { task: "Check the fixture" },
            // The tool may return normally even though admission was forbidden.
            text: JSON.stringify(receipt),
          }),
        ]);
      },
      waitForAgentRun: async (_env: unknown, runId: string) => {
        expect(runId).toBe(child.runId);
        return {
          runId: fault === "another run" ? "other-run" : runId,
          status: fault === "child failed" ? "error" : "ok",
          endedAt: 100,
          yielded: fault === "child yielded",
          terminalReply: {
            disposition: fault === "silent terminal after progress" ? "silent" : "visible",
            text: childReply,
          },
        };
      },
      readSubagentHandoffReply: async (
        _env: unknown,
        sessionKey: string,
        childKey: string,
        text: string,
        messages: unknown[],
      ) => {
        expect(sessionKey).toBe(requester);
        expect(childKey).toBe(child.childSessionKey);
        // This is all in the requester: completed children need not remain in sessions.list.
        const events =
          fault === "parent guessed before completion"
            ? [{ ...report, parentId: "request" }, delivery]
            : [delivery, report];
        return findSubagentHandoffReply(messages, childKey, text, async () => events);
      },
      waitForAgentHistory: async (
        _env: unknown,
        sessionKey: string,
        select: (history: { messages: unknown[] }) => Promise<string | undefined>,
      ) => {
        expect(sessionKey).toBe(requester);
        // Completion input stays internal. A single read may already include the later reply.
        const visible =
          fault === "unrelated public reply"
            ? { ...reply, __openclaw: { id: "another-report" } }
            : reply;
        const selected = await select({ messages: [visible] });
        if (!selected) {
          throw new Error("no matching delivered reply");
        }
        expect(selected).toBe(reply.content);
        return selected;
      },
      ...api,
    },
  });
}

// The yielded requester sees prompt-data's escaped spelling, not a decoded copy.
it.each([
  ["qa-sidecar", "qa-sidecar"],
  ["Verified 2 < 3.\nEvidence:\nCheck passed.", "Verified 2 &lt; 3.\nEvidence:\nCheck passed."],
  ["column A\tcolumn B\r\n2 < 3", "column Acolumn B\n2 &lt; 3"],
  ["literal &lt; stays &lt;", "literal &lt; stays &lt;"],
])(
  "credits the accepted child's settled result in the requester's subsequent visible reply: %s",
  async (childReply, deliveredReply) => {
    await expect(runHandoff({ childReply, deliveredReply })).resolves.toMatchObject({
      status: "pass",
    });
  },
);
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
  try {
    // Let the preceding observations succeed, then expire only the selected wait.
    const pending = runHandoff({
      api: {
        runScenario: runQaSuiteScenarioSteps,
        [wait]: async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 360_000);
          });
          throw new Error(details);
        },
      },
    });
    await vi.advanceTimersByTimeAsync(360_000);
    const result = await pending;
    expect(result.status).toBe("fail");
    expect(result.steps.at(-1)).toMatchObject({ name, status: "fail", details });
  } finally {
    vi.useRealTimers();
  }
});
