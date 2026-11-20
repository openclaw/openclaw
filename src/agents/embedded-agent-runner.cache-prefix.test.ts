import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import {
  normalizeLiveUsage,
  runEmbeddedReleasePrefixScenario,
} from "./embedded-agent-runner.cache.test-support.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import { buildUsageWithNoCost } from "./stream-message-shared.js";

it("keeps the release prefix gate exact across encrypted reasoning cold replay", async () => {
  await withOpenClawTestState({ label: "release-prefix" }, async (state) => {
    const sessionId = "release-prefix";
    const sessionKey = "agent:main:release-prefix";
    const model = "gpt-5-release-prefix-fixture";
    const traceFile = state.path("cache-trace.jsonl");
    const host = getAiTransportHost();
    let requests = 0;
    configureAiTransportHost({
      ...host,
      buildModelFetch: () => async (input, init) => {
        const payload: unknown = await new Request(input, init).json();
        assert(isRecord(payload) && Array.isArray(payload.input));
        requests++;
        if (requests === 10) {
          expect(payload.previous_response_id).toBeUndefined();
          expect(payload.input).toContainEqual({
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted_response_1",
          });
        }
        const id = "response_" + requests;
        const step = ((requests - 1) % 3) + 1;
        const turn = Math.ceil(requests / 3);
        const output = [
          { type: "reasoning", id: "rs_" + id, summary: [], encrypted_content: "encrypted_" + id },
          step < 3
            ? {
                type: "function_call",
                id: "fc_" + id,
                call_id: "call_" + id,
                name: "cache_probe",
                arguments: JSON.stringify({ step }),
              }
            : {
                type: "message",
                id: "msg_" + id,
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "CACHE-OK release-turn-" + turn, annotations: [] },
                ],
              },
        ];
        const events = [
          ...output.flatMap((item, output_index) => [
            { type: "response.output_item.added", output_index, item },
            { type: "response.output_item.done", output_index, item },
          ]),
          {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output,
              usage: {
                input_tokens: 1000,
                output_tokens: 10,
                total_tokens: 1010,
                input_tokens_details: { cached_tokens: 900 },
              },
            },
          },
        ];
        return new Response(
          events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    try {
      await withEnvAsync(
        { OPENCLAW_CACHE_TRACE: "1", OPENCLAW_CACHE_TRACE_FILE: traceFile },
        async () => {
          await runEmbeddedReleasePrefixScenario({
            provider: "openai",
            apiKey: "synthetic-release-key",
            model: {
              id: model,
              name: model,
              provider: "openai",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text"],
              contextWindow: 1000000,
              maxTokens: 1024,
              cost: buildUsageWithNoCost({}).cost,
            },
            sessionId,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            readTraceEvents: async () =>
              (await fs.readFile(traceFile, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line)),
            probe: async (config, suffix) => {
              config.agents!.defaults!.workspace = state.workspaceDir;
              config.skills = { load: { watch: false } };
              await state.writeConfig(config);
              setRuntimeConfigSnapshot(config);
              const runId = sessionId + "-" + suffix;
              const target = {
                agentId: "main",
                sessionId,
                sessionKey,
                storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
              };
              const prompt =
                "Call cache_probe with step 1, then step 2. Reply with exactly CACHE-OK " +
                suffix +
                ".";
              const admission = prepareSystemAgentRunAdmission(
                config,
                runId,
                "main",
                "release-prefix-proof",
              );
              const recorder = createUserTurnTranscriptRecorder({
                target: { ...target, sessionEntry: undefined, config, cwd: state.workspaceDir },
                input: { text: prompt, timestamp: Date.now(), idempotencyKey: runId + ":user" },
              });
              try {
                const result = await runEmbeddedAgent({
                  preparedRunAdmission: admission,
                  userTurnTranscriptRecorder: recorder,
                  sessionId,
                  sessionKey,
                  sessionTarget: target,
                  workspaceDir: state.workspaceDir,
                  agentDir: state.agentDir(),
                  config,
                  prompt,
                  transcriptPrompt: prompt,
                  provider: "openai",
                  model,
                  timeoutMs: 60000,
                  runId,
                  agentHarnessRuntimeOverride: "openclaw",
                  modelSelectionLocked: true,
                  toolsAllow: ["cache_probe"],
                  codeModeOverride: false,
                  thinkLevel: "off",
                  streamParams: { maxTokens: 128 },
                });
                expect(result.meta.error).toBeUndefined();
                expect(result.payloads).toContainEqual(
                  expect.objectContaining({ text: "CACHE-OK " + suffix }),
                );
                return normalizeLiveUsage(result.meta.agentMeta?.usage);
              } finally {
                admission.close();
              }
            },
          });
        },
      );
      expect(requests).toBe(12);
    } finally {
      configureAiTransportHost(host);
    }
  });
}, 120000);
