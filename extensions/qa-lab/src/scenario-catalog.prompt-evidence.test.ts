import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nestedToolHistoryFixture } from "../test/nested-tool-activity-fixture.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const scenarioId = "instruction-profile-artifact-followthrough-live";
const sessionKey = "agent:qa:instruction-profile-artifact:test";
const workspaceDir = "/qa-instruction-profile-workspace";
type GatewayCall = (method: string, input: Record<string, unknown>) => Promise<unknown>;
const currentObservation = {
  egress: "responses-sdk",
  payloadVariant: "initial",
  promptSource: "input.developer",
  expectedChars: 4096,
  observedChars: 4096,
  matchesAssembledPrompt: true,
};
function event(type: string, data: unknown, runId = "current-run") {
  return { type, runId, data };
}

function promptEvent(data: Partial<typeof currentObservation> = {}, runId = "current-run") {
  return event("provider.prompt.observed", { ...currentObservation, ...data }, runId);
}

function instructionScenario() {
  const scenario = readQaScenarioById(scenarioId);
  const actions = scenario.execution.flow?.steps[0]?.actions;
  if (!actions) {
    throw new Error("instruction profile scenario has no actions");
  }
  const config = scenario.execution.config ?? {};
  const text = (key: string) => z.string().parse(config[key]);
  return { actions, text };
}

const matches = (action: unknown, fields: Record<string, string>) =>
  typeof action === "object" &&
  action !== null &&
  Object.entries(fields).every(([key, value]) => Reflect.get(action, key) === value);

function runEvidence(
  actions: unknown[],
  call: GatewayCall,
  api: Record<string, unknown> = {},
  detailsExpr?: string,
) {
  return runLoadedScenarioFlow(scenarioId, {
    api: { path, env: { providerMode: "live-frontier", gateway: { workspaceDir, call } }, ...api },
    flow: {
      steps: [
        {
          name: "instruction profile evidence",
          actions: [{ set: "sessionKey", value: sessionKey }, ...actions],
          detailsExpr,
        },
      ],
    },
  });
}

async function runPromptEvidence(events: unknown[]) {
  const { actions, text } = instructionScenario();
  const exportIndex = actions.findIndex((action) => matches(action, { call: "runQaCli" }));
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
  const chars = text("instructionContents").trimEnd().length;
  const injectedWorkspaceFiles = [
    {
      path: "/qa/AGENTS.md",
      missing: false,
      truncated: false,
      rawChars: chars,
      injectedChars: chars,
    },
  ];
  return await runEvidence(
    [
      { set: "turn", value: { started: { runId: "current-run" } } },
      ...actions.slice(exportIndex, assertionIndex + 1),
    ],
    async (method, input) => {
      expect(method).toBe("sessions.usage");
      expect(input).toEqual({
        key: sessionKey,
        agentId: "qa",
        range: "all",
        limit: 1,
        includeContextWeight: true,
      });
      return { sessions: [{ key: sessionKey, contextWeight: { injectedWorkspaceFiles } }] };
    },
    {
      runQaCli: async () => ({ outputDir: "/qa/trajectory" }),
      fs: {
        readFile: async (file: string) => {
          expect(file).toBe(path.join("/qa/trajectory", "events.jsonl"));
          return [{ type: "trace.metadata", data: { prompting: "[Truncated]" } }, ...events]
            .map((entry) => JSON.stringify(entry))
            .join("\n");
        },
        rm: async () => undefined,
      },
    },
  );
}

async function runNestedToolHistoryEvidence(params: { leakContextMarker?: boolean } = {}) {
  const { actions, text } = instructionScenario();
  const historyEvidenceAction = actions.find((action) =>
    matches(action, { call: "waitForCondition", saveAs: "historyEvidence" }),
  );
  if (!historyEvidenceAction) {
    throw new Error("instruction profile scenario has no history evidence wait");
  }
  const artifactFile = text("artifactFile"),
    nonce = text("nonce");
  const messages = [
    nestedToolHistoryFixture({
      toolName: "read",
      toolCallId: "read-instruction-profile-input",
      input: { path: text("inputFile") },
      text: params.leakContextMarker ? `${nonce} ${text("contextMarker")}` : nonce,
    }),
    nestedToolHistoryFixture({
      toolName: "write",
      toolCallId: "write-instruction-profile-artifact",
      input: { path: artifactFile, content: nonce },
      text: `Wrote ${artifactFile}`,
    }),
    { role: "assistant", content: [{ type: "text", text: text("finalReply") }] },
  ];
  return await runEvidence(
    [historyEvidenceAction],
    async (method, input) => {
      expect(method).toBe("chat.history");
      expect(input).toEqual({ sessionKey, limit: 100, maxChars: 131072 });
      return { messages };
    },
    {},
    "JSON.stringify({ terminalReplies: historyEvidence.visibleAssistant.length, finalText: historyEvidence.final.text })",
  );
}

describe("instruction profile prompt evidence", () => {
  it("bounds prompt evidence to current dispatches despite stale mismatches and marker-bearing diagnostics", async () => {
    await expect(
      runPromptEvidence([
        promptEvent({ observedChars: 0, matchesAssembledPrompt: false }, "stale-run"),
        promptEvent(),
        event("context.compiled", { systemPrompt: "INSTRUCTION-PROFILE-CONTEXT-MARKER-A6E29D4B" }),
        promptEvent({ egress: "native-codex-websocket", promptSource: "instructions" }),
      ]),
    ).resolves.toMatchObject({ status: "pass" });
  });
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
