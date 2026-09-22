import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function readPublicTerminalChecks() {
  const scenario = readQaScenarioById("subagent-completion-direct-fallback");
  const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
  const body = actions
    .map(asOptionalRecord)
    .map((action) => asOptionalRecord(action?.try))
    .find(Boolean);
  if (!Array.isArray(body?.actions)) {
    throw new Error("Terminal completion flow has no protected scenario body");
  }
  const loop = body.actions
    .map(asOptionalRecord)
    .map((action) => asOptionalRecord(action?.forEach))
    .find((action) => action?.item === "terminalCase");
  if (!Array.isArray(loop?.actions)) {
    throw new Error("Terminal completion flow has no public case loop");
  }
  const start = loop.actions.findIndex(
    (action) => asOptionalRecord(action)?.saveAs === "terminalTask",
  );
  const end = loop.actions.findIndex(
    (action) => asOptionalRecord(action)?.set === "appendDirectFallbackProof",
  );
  if (start < 0 || end <= start) {
    throw new Error("Terminal completion flow has no public readiness and acknowledgment checks");
  }
  const cases = scenario.execution.config?.cases;
  const terminalCase = expectDefined(
    Array.isArray(cases) ? asOptionalRecord(cases[0]) : undefined,
    "visible terminal case",
  );
  return {
    actions: loop.actions.slice(start, end),
    terminalCase,
    config: scenario.execution.config ?? {},
  };
}

async function runTerminalAcknowledgment(
  initialAck: "missing" | "deleted" | "foreign" | "duplicate",
) {
  const { actions, terminalCase, config } = readPublicTerminalChecks();
  const conversationId = "terminal-parent-ack";
  const marker = String(terminalCase.marker);
  const acknowledgment = String(config.parentAcknowledgment);
  const state = createQaBusState();
  const addAck = (conversation = conversationId) =>
    state.addOutboundMessage({
      accountId: "default",
      to: `dm:${conversation}`,
      text: acknowledgment,
    });
  state.addOutboundMessage({ accountId: "default", to: `dm:${conversationId}`, text: marker });
  if (initialAck === "deleted") {
    state.deleteMessage({ accountId: "default", messageId: addAck().id });
  } else if (initialAck === "foreign") {
    addAck("another-conversation");
  } else if (initialAck === "duplicate") {
    addAck();
    addAck();
  }
  return runLoadedScenarioFlow("subagent-completion-direct-fallback", {
    state,
    flow: {
      steps: [
        {
          name: "waits for independently delivered parent acknowledgment",
          actions: [
            { set: "terminalCase", value: terminalCase },
            { set: "conversationId", value: conversationId },
            { set: "startIndex", value: 0 },
            { set: "requestCursor", value: 0 },
            { set: "activePhase", value: "public:visible" },
            ...actions,
          ],
        },
      ],
    },
    api: {
      readSettledTerminalTask: async () => ({ taskId: "completed-child" }),
      readDirectFallbackReceipts: async () => [{ content: [{ type: "text", text: marker }] }],
      publishTerminalDiagnostic: async () => undefined,
      snapshotTerminalRequests: () => [],
      waitForCondition: async <T>(check: () => Promise<T | undefined>) => {
        const beforeAcknowledgment = await check();
        if (beforeAcknowledgment !== undefined) {
          return beforeAcknowledgment;
        }
        addAck();
        return expectDefined(await check(), "readiness after parent acknowledgment");
      },
    },
  });
}

describe("subagent terminal acknowledgment readiness", () => {
  it.each(["missing", "deleted", "foreign"] as const)(
    "waits for a live parent acknowledgment when the initial acknowledgment is %s",
    async (initialAck) => {
      await expect(runTerminalAcknowledgment(initialAck)).resolves.toMatchObject({
        status: "pass",
      });
    },
  );

  it("still rejects duplicate parent acknowledgments after readiness", async () => {
    await expect(runTerminalAcknowledgment("duplicate")).rejects.toThrow(
      "spawning parent did not acknowledge its completed turn",
    );
  });
});
