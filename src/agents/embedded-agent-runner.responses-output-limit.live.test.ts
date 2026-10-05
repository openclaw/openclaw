// Genuine provider output-limit recovery through the embedded run owner.
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import type {
  Response as ResponsesResponse,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import type { EmbeddedAgentEvent } from "./embedded-agent-subscribe.shared-types.js";
import {
  createContextEngineLogicalTurnLease,
  type ContextEngineLogicalTurnLease,
} from "./harness/context-engine-logical-turn.js";
import { shellQuoteArgs } from "./harness/native-hook-relay-utils.js";
import { isLiveTestEnabled, logLiveProgress } from "./live-test-helpers.js";
import { SessionManager } from "./sessions/session-manager.js";

const describeLive =
  isLiveTestEnabled() && process.env.OPENAI_API_KEY?.trim() ? describe : describe.skip;

function observeTerminalResponse(
  response: Response,
  onTerminal: (terminal: ResponsesResponse) => void,
): Response {
  if (!response.body) {
    throw new Error("Live Responses request returned no stream body");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  // The SDK cancels its reader at the terminal event; observe before forwarding unchanged bytes.
  const observer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffered))) {
        const frame = buffered.slice(0, separator.index);
        buffered = buffered.slice(separator.index + separator[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") {
          continue;
        }
        const event = JSON.parse(data) as ResponseStreamEvent;
        if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        ) {
          onTerminal(event.response);
        }
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(observer), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

describeLive("embedded Responses output-limit recovery live", () => {
  it("continues from a committed receipt after a real truncated tool call", async () => {
    await withOpenClawTestState({ label: "responses-output-limit-live" }, async (state) => {
      const modelId = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
      const receiptPath = path.join(state.workspaceDir, "receipts.txt");
      const unfinishedPath = path.join(state.workspaceDir, "unfinished.txt");
      const scriptPath = path.join(state.workspaceDir, "record-receipt.cjs");
      await fs.writeFile(
        scriptPath,
        'const fs = require("node:fs");\n' +
          'const receipt = "RECEIPT_" + require("node:crypto").randomUUID();\n' +
          `fs.appendFileSync(${JSON.stringify(receiptPath)}, receipt + "\\n");\n` +
          "console.log(receipt);\n",
      );
      const command = shellQuoteArgs([process.execPath, scriptPath]);
      const config = {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              auth: "api-key",
              baseUrl: "https://api.openai.com/v1",
              timeoutSeconds: 90,
              models: [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 200_000,
                  maxTokens: 1024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        agents: {
          list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          defaults: {
            skipBootstrap: true,
            models: { [`openai/${modelId}`]: { params: { transport: "sse" } } },
          },
        },
        tools: { exec: { host: "gateway", mode: "full" } },
        plugins: { allow: ["openai"], slots: { memory: "none" } },
      } satisfies OpenClawConfig;
      await state.writeConfig(config);
      const sessionManager = SessionManager.inMemory(state.workspaceDir);
      const events: EmbeddedAgentEvent[] = [];
      const requests: ResponseCreateParamsStreaming[] = [];
      const responses: ResponsesResponse[] = [];
      const host = getAiTransportHost();
      const admission = prepareSystemAgentRunAdmission(
        config,
        "responses-output-limit-live",
        "main",
        "responses-output-limit-live",
      );
      let contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease | undefined;
      configureAiTransportHost({
        ...host,
        buildModelFetch: (...args) => {
          const fetchModel = host.buildModelFetch(...args) ?? globalThis.fetch;
          return async (input, init) => {
            if (requests.length >= 3) {
              throw new Error("Live output-limit proof exceeded three Responses requests");
            }
            // Responses bodies are pre-encoded bytes; decode without consuming init.
            const request = (await new Request(
              input,
              init,
            ).json()) as ResponseCreateParamsStreaming;
            const requestNumber = requests.length + 1;
            const toolName = requestNumber === 1 ? "exec" : "write";
            if (requestNumber <= 2) {
              expect(request.tools).toContainEqual(
                expect.objectContaining({ type: "function", name: toolName }),
              );
            }
            request.tool_choice =
              requestNumber <= 2 ? { type: "function", name: toolName } : "none";
            request.parallel_tool_calls = false;
            request.max_output_tokens = requestNumber === 2 ? 256 : 1024;
            if (requestNumber === 2) {
              // Spend the small cap on function arguments, not a reasoning-only turn.
              request.reasoning = { effort: "none" };
            }
            // Only request policy changes: the provider's stream and terminal facts stay intact.
            requests.push(request);
            const response = await fetchModel(input, { ...init, body: JSON.stringify(request) });
            return observeTerminalResponse(response, (terminal) => responses.push(terminal));
          };
        },
      });
      try {
        // Command/Gateway run-entry owns this lease before preparing model candidates.
        contextEngineLogicalTurnLease = await createContextEngineLogicalTurnLease({
          identity: {
            runId: "responses-output-limit-live",
            sessionId: "responses-output-limit-live",
          },
          config,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
        });
        const result = await runEmbeddedAgent({
          preparedRunAdmission: admission,
          contextEngineLogicalTurnLease,
          agentId: "main",
          sessionId: "responses-output-limit-live",
          sessionKey: "agent:main:responses-output-limit-live",
          sessionManager,
          sessionPersistence: "detached",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          config,
          provider: "openai",
          model: modelId,
          agentHarnessRuntimeOverride: "openclaw",
          modelSelectionLocked: true,
          codeModeOverride: false,
          thinkLevel: "off",
          toolsAllow: ["exec", "write"],
          requireWorkspaceOnly: true,
          execOverrides: { host: "gateway", mode: "full" },
          prompt:
            `First use exec to run exactly this command once: ${command}\n` +
            `Set workdir to ${JSON.stringify(state.workspaceDir)}. Preserve its printed receipt.\n` +
            `Then use write to create ${JSON.stringify(unfinishedPath)} with the literal text ` +
            '"0123456789" repeated 4000 times. Supply the entire expanded string as content.\n' +
            "The content argument must contain all 40,000 digits, without code, placeholders, ellipses, or repetition notation.\n" +
            "If writing is interrupted, do not retry either action. " +
            "Finish by reporting the exact receipt from the completed exec result.",
          timeoutMs: 180_000,
          runId: "responses-output-limit-live",
          cleanupBundleMcpOnRunEnd: true,
          onAgentEvent: (event) => {
            events.push(event);
          },
        });

        const receipts = (await fs.readFile(receiptPath, "utf8")).trim().split("\n");
        expect(receipts).toHaveLength(1);
        const receipt = receipts[0];
        expect(receipt).toMatch(/^RECEIPT_[0-9a-f-]{36}$/);
        await expect(fs.stat(unfinishedPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(requests).toHaveLength(3);
        const terminalFacts = responses.map((response) => ({
          status: response.status,
          incompleteReason: response.incomplete_details?.reason,
          outputItems: response.output.map((item) => ({
            type: item.type,
            status: "status" in item ? item.status : undefined,
          })),
        }));
        logLiveProgress(`Responses terminal facts: ${JSON.stringify(terminalFacts)}`);
        expect(terminalFacts).toHaveLength(3);
        expect(terminalFacts[1]).toMatchObject({
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          outputItems: expect.arrayContaining([{ type: "function_call", status: "incomplete" }]),
        });
        // Recovery may continue from provider state or replay the committed durable transcript.
        // The latter deliberately omits previous_response_id, so prove the receipt survived instead.
        expect(JSON.stringify(requests[2]?.input)).toContain(receipt);
        expect(JSON.stringify(requests[2]?.input)).toContain(
          "Split the remaining work into smaller tool calls",
        );
        expect(JSON.stringify(requests[2]?.input)).toContain("max_output_tokens");
        expect(result.payloads?.map((payload) => payload.text ?? "").join("\n")).toContain(receipt);
        expect(result.payloads?.some((payload) => payload.isError)).toBe(false);
        expect(
          events.filter(
            (event) => event.stream === "run_status" && event.data.reason === "output_limit",
          ),
        ).toHaveLength(1);
        const messages = sessionManager
          .getBranch()
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        const failures = messages.filter(
          (message) => message.role === "assistant" && message.errorCode === "incomplete_tool_call",
        );
        expect(messages).toContainEqual(
          expect.objectContaining({ role: "custom", customType: "incomplete-tool-call" }),
        );
        expect(failures).toEqual([
          expect.objectContaining({
            stopReason: "error",
            usage: expect.objectContaining({ output: 256 }),
            diagnostics: expect.arrayContaining([
              expect.objectContaining({
                type: "openai_responses_terminal",
                details: expect.objectContaining({
                  eventType: "response.incomplete",
                  incompleteReason: "max_output_tokens",
                }),
              }),
            ]),
          }),
        ]);
        expect(
          messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "exec",
          ),
        ).toHaveLength(1);
        expect(
          messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "write",
          ),
        ).toHaveLength(0);
      } finally {
        await admission.close();
        configureAiTransportHost(host);
        await contextEngineLogicalTurnLease?.dispose();
      }
    });
  }, 210_000);
});
