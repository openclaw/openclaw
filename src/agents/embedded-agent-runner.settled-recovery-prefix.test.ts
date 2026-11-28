// The NO_REPLY recovery request is one more request of the settled turn: it sends that turn's prefix.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import {
  cacheRunnerConfig,
  providerResponse,
  type WireApi,
} from "./embedded-agent-runner.wire.test-support.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";

type Payload = Record<string, unknown> & { messages?: unknown[]; input?: unknown[] };
type Reply = "tool" | "silent" | "answer";
// A cold first runner turn took over 120s on a loaded host.
const TEST_TIMEOUT_MS = 240_000;

const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");

/** Anthropic reply with a synthetic signed thinking block before its answer. */
function thinkingAnswer(model: string): Response {
  const blocks = [
    { type: "thinking", thinking: "<placeholder>", signature: "sig-1" },
    { type: "text", text: "Recovered final answer." },
  ];
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_recovery",
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
    },
    ...blocks.flatMap((content_block, index) => [
      { type: "content_block_start", index, content_block },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function runSettledTurn(params: {
  api: WireApi;
  provider: string;
  model: string;
  replies: Reply[];
}) {
  const { api, provider, model } = params;
  return await withOpenClawTestState({ label: `recovery-prefix-${api}` }, async (state) => {
    const pluginDir = state.path("recovery-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "recovery-proof",
        activation: { onStartup: true },
        contracts: { tools: ["cache_probe"] },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `module.exports = { id: "recovery-proof", register(api) {
        api.registerTool({ name: "cache_probe", label: "Cache probe", description: "Return a synthetic record.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "synthetic tool result" }] }) });
      }};`,
    );
    const config = cacheRunnerConfig({
      api,
      provider,
      model,
      workspaceDir: state.workspaceDir,
      pluginId: "recovery-proof",
      pluginDir,
      apiKey: "synthetic-recovery-proof",
      input: ["text"],
      tools: ["cache_probe"],
      modelSettings: { params: { transport: "sse", cacheRetention: "short" } },
    });
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    await loadAndActivateRootPluginRegistry({
      config,
      workspaceDir: state.workspaceDir,
      throwOnLoadError: true,
    });
    const sessionId = `recovery-${api}`;
    const sessionKey = `agent:main:${sessionId}`;
    const target = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    const host = getAiTransportHost();
    const requests: Payload[] = [];
    // Responses continuations send a delta; record each request's effective input.
    const responseInputs = new Map<string, unknown[]>();
    const replies = [...params.replies];
    configureAiTransportHost({
      ...host,
      buildModelFetch: () => async (input, init) => {
        const payload = (await new Request(input, init).json()) as Payload;
        const previous = payload.previous_response_id;
        const effective = payload.input && [
          ...(typeof previous === "string" ? (responseInputs.get(previous) ?? []) : []),
          ...payload.input,
        ];
        requests.push(effective ? { ...payload, input: effective } : payload);
        const reply = replies.shift() ?? "answer";
        if (reply === "answer" && api === "anthropic-messages") {
          return thinkingAnswer(model);
        }
        const id = `resp_${requests.length}`;
        const response = providerResponse({
          api,
          model,
          id,
          messageId: `msg_${id}`,
          text: reply === "silent" ? "NO_REPLY" : "Recovered final answer.",
          calls:
            reply === "tool"
              ? [
                  {
                    id: `${api === "anthropic-messages" ? "toolu" : "call"}_${id}`,
                    name: "cache_probe",
                  },
                ]
              : [],
        });
        if (effective) {
          const output = response.output.map(({ id: _id, ...item }) => item);
          responseInputs.set(id, [...effective, ...output]);
        }
        return response.response;
      },
    });
    const runId = `${sessionId}-run`;
    const admission = prepareSystemAgentRunAdmission(config, runId, "main", "recovery-proof");
    try {
      const result = await runEmbeddedAgent({
        preparedRunAdmission: admission,
        agentId: "main",
        sessionId,
        sessionKey,
        sessionTarget: target,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        config,
        provider,
        model,
        agentHarnessRuntimeOverride: "openclaw",
        modelSelectionLocked: true,
        codeModeOverride: false,
        thinkLevel: "off",
        toolsAllow: ["cache_probe"],
        terminalReplyExpectation: "result-required",
        runId,
        timeoutMs: 120_000,
        prompt: "Check the record, then answer.",
      });
      return { requests, result };
    } finally {
      admission.close();
      cleanupSessionResources(sessionId);
      configureAiTransportHost(host);
      clearEmbeddedSessionPromptStates([sessionId]);
      await clearActivePluginRegistry();
    }
  });
}

it.each([
  ["anthropic-messages", "anthropic", "claude-sonnet-4-6", "messages"],
  ["openai-responses", "openai", "gpt-5.5", "input"],
] as const)(
  "sends the turn's %s prefix in the NO_REPLY recovery request",
  { timeout: TEST_TIMEOUT_MS },
  async (api, provider, model, items) => {
    const { requests, result } = await runSettledTurn({
      api,
      provider,
      model,
      replies: ["tool", "silent", "answer"],
    });
    expect(requests).toHaveLength(3);
    const [, turn, recovery] = requests as [Payload, Payload, Payload];
    const turnItems = turn[items]!;
    const recoveryItems = recovery[items]!;
    // System, tools, model, thinking and cache key: every parameter but tool_choice matches.
    const params = (payload: Payload) => ({
      ...payload,
      [items]: undefined,
      tool_choice: undefined,
      previous_response_id: undefined,
    });
    expect(digest(recovery.system ?? recovery.instructions)).toBe(
      digest(turn.system ?? turn.instructions),
    );
    expect(digest(params(recovery))).toBe(digest(params(turn)));
    // Byte-identical to the turn's request up to the new user message.
    expect(digest(recoveryItems.slice(0, turnItems.length))).toBe(digest(turnItems));
    expect(recoveryItems.length).toBeGreaterThan(turnItems.length);
    expect(JSON.stringify(recoveryItems.at(-1))).toContain("Your turn ended without a final");
    // tool_choice is outside the cache key on both protocols; the recovery forbids tool calls.
    expect(recovery.tool_choice).toEqual(api === "anthropic-messages" ? { type: "none" } : "none");
    expect(result.payloads?.map((payload) => payload.text)).toEqual(["Recovered final answer."]);
  },
);
