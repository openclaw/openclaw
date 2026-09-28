import path from "node:path";
import { describe, expect, it } from "vitest";
import { nestedToolHistoryFixture } from "../test/nested-tool-activity-fixture.js";
import { readQaScenarioById, type QaScenarioFlow } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const scenarioId = "instruction-profile-artifact-followthrough-live";
const sessionKey = "agent:qa:instruction-profile-artifact:test";
const currentObservation = {
  egress: "responses-sdk",
  payloadVariant: "initial",
  promptSource: "input.developer",
  expectedChars: 4096,
  observedChars: 4096,
  matchesAssembledPrompt: true,
};
const currentEvent = {
  type: "provider.prompt.observed",
  runId: "current-run",
  data: currentObservation,
};

async function runPromptEvidence(
  params: {
    events?: unknown[];
    report?: Record<string, unknown>;
    reportSessionKey?: string;
  } = {},
) {
  const scenario = readQaScenarioById(scenarioId);
  const actions = scenario.execution.flow?.steps[0]?.actions;
  if (!actions) {
    throw new Error("instruction profile scenario has no actions");
  }
  const exportIndex = actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      action.call === "runQaCli",
  );
  const assertionIndex = actions.findIndex(
    (action, index) =>
      index > exportIndex &&
      typeof action === "object" &&
      action !== null &&
      "assert" in action &&
      JSON.stringify(action).includes("current-run provider prompt evidence mismatch"),
  );
  if (exportIndex < 0 || assertionIndex < 0) {
    throw new Error("instruction profile scenario has no provider prompt evidence assertion");
  }
  const instructionContents = scenario.execution.config?.instructionContents;
  if (typeof instructionContents !== "string") {
    throw new Error("instruction profile scenario has no instruction contents");
  }
  const flow: QaScenarioFlow = {
    steps: [
      {
        name: "acquires bounded current-run prompt evidence",
        actions: [
          { set: "sessionKey", value: sessionKey },
          { set: "turn", value: { started: { runId: "current-run" } } },
          ...actions.slice(exportIndex, assertionIndex + 1),
        ],
      },
    ],
  };
  return await runLoadedScenarioFlow(scenarioId, {
    flow,
    api: {
      path,
      env: {
        gateway: {
          call: async (method: string, input: Record<string, unknown>) => {
            expect(method).toBe("sessions.usage");
            expect(input).toEqual({
              key: sessionKey,
              agentId: "qa",
              range: "all",
              limit: 1,
              includeContextWeight: true,
            });
            return {
              sessions: [
                {
                  key: params.reportSessionKey ?? sessionKey,
                  contextWeight: {
                    injectedWorkspaceFiles: [
                      {
                        path: "/qa/AGENTS.md",
                        missing: false,
                        truncated: false,
                        rawChars: instructionContents.trimEnd().length,
                        injectedChars: instructionContents.trimEnd().length,
                        ...params.report,
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      },
      runQaCli: async () => ({ outputDir: "/qa/trajectory" }),
      fs: {
        readFile: async (file: string) => {
          if (file === path.join("/qa/trajectory", "prompts.json")) {
            return JSON.stringify({ captured: true });
          }
          if (file === path.join("/qa/trajectory", "events.jsonl")) {
            return [
              { type: "trace.metadata", data: { prompting: "[Truncated]" } },
              ...(params.events ?? [currentEvent]),
            ]
              .map((event) => JSON.stringify(event))
              .join("\n");
          }
          throw new Error(`unexpected evidence file: ${file}`);
        },
        rm: async () => undefined,
      },
    },
  });
}

async function runNestedToolHistoryEvidence(params: { leakContextMarker?: boolean } = {}) {
  const scenario = readQaScenarioById(scenarioId);
  const actions = scenario.execution.flow?.steps[0]?.actions;
  if (!actions) {
    throw new Error("instruction profile scenario has no actions");
  }
  const historyEvidenceAction = actions.find(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      action.call === "waitForCondition" &&
      "saveAs" in action &&
      action.saveAs === "historyEvidence",
  );
  if (!historyEvidenceAction) {
    throw new Error("instruction profile scenario has no history evidence wait");
  }
  const config = scenario.execution.config ?? {};
  const { artifactFile, contextMarker, finalReply, inputFile, nonce } = config;
  if (
    typeof artifactFile !== "string" ||
    typeof contextMarker !== "string" ||
    typeof finalReply !== "string" ||
    typeof inputFile !== "string" ||
    typeof nonce !== "string"
  ) {
    throw new Error("instruction profile scenario has incomplete artifact evidence config");
  }
  const workspaceDir = "/qa-instruction-profile-workspace";
  const messages = [
    nestedToolHistoryFixture({
      toolName: "read",
      toolCallId: "read-instruction-profile-input",
      input: { path: inputFile },
      text: params.leakContextMarker ? `${nonce} ${contextMarker}` : nonce,
    }),
    nestedToolHistoryFixture({
      toolName: "write",
      toolCallId: "write-instruction-profile-artifact",
      input: { path: artifactFile, content: nonce },
      text: `Wrote ${artifactFile}`,
    }),
    { role: "assistant", content: [{ type: "text", text: finalReply }] },
  ];
  const flow: QaScenarioFlow = {
    steps: [
      {
        name: "recognizes nested read and write history evidence",
        actions: [{ set: "sessionKey", value: sessionKey }, historyEvidenceAction],
        detailsExpr:
          "JSON.stringify({ terminalReplies: historyEvidence.visibleAssistant.length, finalText: historyEvidence.final.text })",
      },
    ],
  };
  return await runLoadedScenarioFlow(scenarioId, {
    flow,
    api: {
      path,
      env: {
        providerMode: "live-frontier",
        gateway: {
          workspaceDir,
          call: async (method: string, input: Record<string, unknown>) => {
            expect(method).toBe("chat.history");
            expect(input).toEqual({ sessionKey, limit: 100, maxChars: 131072 });
            return { messages };
          },
        },
      },
    },
  });
}

describe("instruction profile prompt evidence", () => {
  it("acquires full injection evidence despite truncated metadata and stale provider mismatches", async () => {
    const result = await runPromptEvidence({
      events: [
        {
          ...currentEvent,
          runId: "stale-run",
          data: { ...currentObservation, observedChars: 0, matchesAssembledPrompt: false },
        },
        currentEvent,
      ],
    });
    expect(result.status).toBe("pass");
  });

  it("excludes marker-bearing diagnostic context from bounded no-leak evidence", async () => {
    const marker = "INSTRUCTION-PROFILE-CONTEXT-MARKER-A6E29D4B";
    const result = await runPromptEvidence({
      events: [
        {
          type: "context.compiled",
          runId: "current-run",
          data: { systemPrompt: `diagnostic support context ${marker}` },
        },
        {
          ...currentEvent,
          data: {
            ...currentObservation,
            egress: "native-codex-websocket",
            promptSource: "instructions",
          },
        },
      ],
    });
    expect(result.status).toBe("pass");
  });

  it.each([
    { name: "missing file", report: { missing: true } },
    { name: "truncated injection", report: { truncated: true } },
    { name: "incomplete source", report: { rawChars: 1 } },
    { name: "incomplete injection", report: { injectedChars: 1 } },
    { name: "another session's report", reportSessionKey: "agent:qa:other" },
    { name: "missing current-run dispatch", events: [{ ...currentEvent, runId: "stale-run" }] },
    {
      name: "mismatched dispatch",
      events: [{ ...currentEvent, data: { ...currentObservation, matchesAssembledPrompt: false } }],
    },
  ])("rejects $name", async (params) => {
    await expect(runPromptEvidence(params)).rejects.toThrow(
      "current-run provider prompt evidence mismatch",
    );
  });
});

describe("instruction profile tool history evidence", () => {
  it("recognizes canonical nested receipts without counting them as visible replies", async () => {
    const result = await runNestedToolHistoryEvidence();

    expect(result.status).toBe("pass");
    expect(JSON.parse(result.steps[0]?.details ?? "{}")).toEqual({
      terminalReplies: 1,
      finalText: "WROTE instruction-profile-proof.txt",
    });
  });

  it("rejects a protected marker leaked through a canonical nested receipt", async () => {
    await expect(runNestedToolHistoryEvidence({ leakContextMarker: true })).rejects.toThrow(
      "test condition was not met",
    );
  });
});
