import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  prepareCodeModeMatrixTaskFixture,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
} from "../../../scripts/code-mode-model-matrix.ts";

export const frozenFrontierConfig = `{
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6@openai:matrix", fallbacks: [] },
      models: {
        "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } },
      },
    },
  },
  auth: {
    profiles: {
      "openai:matrix": { provider: "openai", mode: "api_key" },
    },
  },
}\n`;

export const matrixFrontierAuthProfile = async (_params: { profileId: string }) => ({
  credentialEnvName: "OPENAI_API_KEY",
  credentialValue: "sk-matrix-test",
  mode: "api_key" as const,
  present: true,
  provider: "openai",
});

type MatrixRunCellParams = Parameters<
  NonNullable<NonNullable<Parameters<typeof runCodeModeModelMatrix>[1]>["runCell"]>
>[0];

const exact = (value: number) => ({ state: "exact" as const, value });

function frontierDigest(
  key: string,
  domain:
    | "task"
    | "full-input"
    | "comparable-input"
    | "logical-call"
    | "prompt-cache-key"
    | "tool-schema",
  value: string,
): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`openclaw-frontier-${domain}-v1\0`)
    .update(value, "utf8")
    .digest("hex");
}

export function deriveTestPromptCacheKey(key: string, runNonce: string): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update("openclaw-frontier-prompt-cache-key-v1\0")
    .update(runNonce, "utf8")
    .digest("hex");
}

export async function validFrontierCellResult(
  params: MatrixRunCellParams,
  options: { passed?: boolean } = {},
): Promise<CodeModeMatrixCellResult> {
  const fixture = await prepareCodeModeMatrixTaskFixture(
    path.join(params.campaignRoot, "synthetic", params.cell.id),
    params.cell,
  );
  const policy = JSON.parse(await fs.readFile(params.frontierEvidencePolicy!.path, "utf8")) as {
    authBindingId: string;
    contentDigestKey: string;
    credentialState: "frozen_in_memory";
  };
  const runNonce = params.frontierEvidenceRunNonce;
  if (!runNonce) {
    throw new Error("frontier evidence run nonce missing");
  }
  const cacheKey = deriveTestPromptCacheKey(policy.contentDigestKey, runNonce);
  const callId = `provider-call-${params.cell.id}`;
  const logicalCallBindingId = frontierDigest(policy.contentDigestKey, "logical-call", callId);
  const passed = options.passed ?? true;
  const physicalFetchDispatch = params.cell.mode === "code" ? 1 : 2;
  const totalToolOperations = params.cell.mode === "code" ? 2 : 1;
  return {
    buildSha256: params.buildSha256,
    firstLogicalCallCacheStatus: "cold",
    codeModeEngaged: params.cell.mode === "code",
    configSha256: params.configSha256,
    elapsedMs: 10,
    wallLatencyMs: 10,
    expected: fixture.expected,
    failureCategory: passed ? null : "answer_mismatch",
    final: passed ? fixture.expected : "wrong",
    frontierEvidence: [
      {
        version: 1,
        policySha256: params.frontierEvidencePolicy!.sha256,
        authBindingId: policy.authBindingId,
        credentialState: policy.credentialState,
        promptCacheKeyDigest: frontierDigest(policy.contentDigestKey, "prompt-cache-key", cacheKey),
        valid: true,
        logicalCalls: 1,
        requestObservations: 1,
        fetchDispatchObservations: physicalFetchDispatch,
        payloadVariants: ["initial"],
        callSequences: [
          {
            logicalCallOrdinal: 1,
            logicalCallBindingId,
            requestCount: 1,
            fetchDispatchCount: physicalFetchDispatch,
            payloadVariants: ["initial"],
            requests: [
              {
                requestOrdinal: 1,
                payloadVariant: "initial",
                fetchDispatchCount: physicalFetchDispatch,
                taskDigest: frontierDigest(policy.contentDigestKey, "task", fixture.prompt),
                fullInputDigest: frontierDigest(
                  policy.contentDigestKey,
                  "full-input",
                  params.cell.id,
                ),
                comparableInputDigest: frontierDigest(
                  policy.contentDigestKey,
                  "comparable-input",
                  `${params.cell.mode}\0${params.cell.task}`,
                ),
                toolSchemaDigest: frontierDigest(
                  policy.contentDigestKey,
                  "tool-schema",
                  params.cell.mode,
                ),
              },
            ],
          },
        ],
        mismatchCodes: [],
      },
    ],
    fixtureSha256: fixture.fixtureSha256,
    gitSha: params.gitSha,
    id: params.cell.id,
    mode: params.cell.mode,
    model: params.cell.model,
    observedModel: params.cell.model.slice(params.cell.model.indexOf("/") + 1),
    observedProvider: "openai",
    oracle: {
      answer: passed,
      effect: true,
      engagement: true,
      identity: true,
      toolExecution: true,
    },
    passed,
    promptSha256: fixture.promptSha256,
    repetition: params.cell.repetition,
    sourceDirty: params.sourceDirty,
    sourcePatchSha256: params.sourcePatchSha256,
    status: "ok",
    task: params.cell.task,
    timestamp: "2026-08-06T00:00:00.000Z",
    trace: {
      schemaVersion: 4,
      source: "agent-command-accounting",
      route: {
        provider: "openai",
        model: params.cell.model.slice(params.cell.model.indexOf("/") + 1),
        api: "openai-responses",
        runtime: "embedded",
      },
      frontierEvidence: {
        receiptCount: 1,
        valid: true,
        logicalCalls: 1,
        requestObservations: 1,
        physicalFetchDispatch,
        payloadVariants: ["initial"],
        callSequences: [
          {
            logicalCallOrdinal: 1,
            requestCount: 1,
            fetchDispatchCount: physicalFetchDispatch,
            payloadVariants: ["initial"],
            requests: [
              {
                requestOrdinal: 1,
                payloadVariant: "initial",
                fetchDispatchCount: physicalFetchDispatch,
              },
            ],
          },
        ],
      },
      metrics: {
        effectiveTurns: exact(params.cell.mode === "code" ? 1 : 2),
        logicalModelCalls: exact(1),
        providerAttempts: {
          total: exact(1),
          initial: exact(1),
          retries: exact(0),
          authRecoveries: exact(0),
          payloadRecoveries: exact(0),
          transportFallbacks: exact(0),
        },
        physicalFetchDispatch: exact(physicalFetchDispatch),
        outerToolCalls: exact(1),
        codeModeBridgeCalls: exact(params.cell.mode === "code" ? 1 : 0),
        totalToolOperations: exact(totalToolOperations),
        underlyingTotalCalls: exact(physicalFetchDispatch + totalToolOperations),
        tokens: {
          input: exact(params.cell.mode === "code" ? 60 : 80),
          cachedInput: exact(params.cell.repetition === 1 ? 0 : 10),
          firstLogicalCallCachedInput: exact(0),
          output: exact(10),
          reasoning: exact(0),
          total: exact(params.cell.mode === "code" ? 70 : 90),
        },
        agentDurationMs: exact(5),
        commandExecutionDurationMs: exact(10),
      },
      audit: { state: "valid" },
    },
    workspaceIdentitySha256: fixture.workspaceIdentitySha256,
    workspaceSeedSha256: fixture.workspaceSeedSha256,
  };
}
