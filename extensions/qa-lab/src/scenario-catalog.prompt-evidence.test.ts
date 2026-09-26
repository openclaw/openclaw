import path from "node:path";
import { describe, expect, it } from "vitest";
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
