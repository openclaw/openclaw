import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { extractGatewayMessageText } from "./gateway-log-sentinel.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { runAgentPrompt } from "./suite-runtime-agent-process.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import { formatTransportTranscript, waitForOutboundMessage } from "./suite-runtime-transport.js";
import { projectQaToolMessages } from "./tool-activity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const observeStatusWait = vi.hoisted(() => vi.fn());
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => {
    observeStatusWait();
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function runImageScenario(
  options: {
    fault?:
      | "late duplicate message"
      | "failed turn"
      | "initial acknowledgement only"
      | "wrong completion run"
      | "mismatched completion text";
    isGenerating?: () => boolean;
  } = {},
) {
  const scenario = readQaScenarioById("native-image-generation");
  if (!scenario.execution.flow) {
    throw new Error("expected native image flow");
  }
  const state = createQaBusState();
  const generatedPath = path.join(tempDirs.make("qa-generated-image-"), "generated.png");
  await fs.writeFile(generatedPath, png);
  const caption = "A QA lighthouse on the coast.";
  const taskId = "tool:image_generate:qa-image";
  const completionRunId = `image_generate:${taskId}:ok:agent-loop:attempt:1`;
  const attachment = {
    id: "generated-image",
    kind: "image" as const,
    mimeType: "image/png",
    contentBase64: png.toString("base64"),
  };
  const deliverImage = () =>
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "",
      attachments: [attachment],
    });
  let settled = false;
  const sessionKey = "agent:qa:image-generate:test";
  const env = {
    providerMode: "live-frontier",
    runtimeId: "openclaw",
    gateway: {
      call: async (method: string, params: unknown) => {
        if (method === "tools.invoke") {
          expect(params).toEqual({
            name: "image_generate",
            args: { action: "status" },
            sessionKey,
            agentId: "qa",
          });
          const active = options.isGenerating?.() ?? false;
          settled = !active;
          return {
            ok: true,
            toolName: "image_generate",
            output: { details: { action: "status", active } },
          };
        }
        if (method === "chat.history") {
          expect(params).toEqual({ sessionKey, limit: 100, maxChars: 131072 });
          const actions = ["status", "generate", "status"];
          return {
            messages: [
              ...actions.flatMap((action, index) => {
                const call = {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: `image-${index}`,
                      name: "image_generate",
                      arguments: { action },
                    },
                  ],
                };
                return [
                  call,
                  {
                    role: "toolResult",
                    toolCallId: `image-${index}`,
                    toolName: "image_generate",
                    isError: false,
                    content:
                      action === "generate"
                        ? [
                            {
                              type: "text",
                              text: `Background task started for image generation (${taskId}). Do not call image_generate again for this request.`,
                            },
                          ]
                        : [],
                  },
                ];
              }),
              ...(options.fault === "initial acknowledgement only"
                ? []
                : [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: caption }],
                      __openclaw: {
                        runId:
                          options.fault === "wrong completion run"
                            ? "initial-run"
                            : completionRunId,
                      },
                    },
                  ]),
            ],
          };
        }
        if (method === "agent") {
          if (options.isGenerating || options.fault === "initial acknowledgement only") {
            state.addOutboundMessage({
              to: "dm:qa-operator",
              text:
                options.fault === "initial acknowledgement only"
                  ? caption
                  : "Rendering the lighthouse.",
            });
          }
          return { runId: "image-run" };
        }
        if (method !== "agent.wait") {
          throw new Error(`unexpected RPC: ${method}`);
        }
        if (options.fault === "failed turn") {
          return { status: "error", error: "image generation failed" };
        }
        deliverImage();
        if (options.fault !== "initial acknowledgement only") {
          state.addOutboundMessage({
            to: "dm:qa-operator",
            text: options.fault === "mismatched completion text" ? "Unpersisted caption." : caption,
          });
        }
        return {
          status: "ok",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReply: { disposition: "visible", text: "A QA lighthouse on the coast." },
        };
      },
    },
    transport: { buildAgentDelivery: () => ({ channel: "qa-channel", to: "dm:qa-operator" }) },
    mock: null,
  };
  return runScenarioFlow({
    scenarioTitle: scenario.title,
    flow: scenario.execution.flow,
    api: {
      scenario,
      config: scenario.execution.config ?? {},
      env,
      state,
      fs,
      ensureImageGenerationConfigured: async () => {},
      createSession: async () => sessionKey,
      randomUUID: () => "test",
      normalizeLowercaseStringOrEmpty,
      projectQaToolMessages,
      extractGatewayMessageText,
      readEffectiveTools: async () => new Set(["image_generate"]),
      reset: () => state.reset(),
      runAgentPrompt,
      liveTurnTimeoutMs: (_env: unknown, value: number) => value,
      waitForOutboundMessage,
      waitForCondition: waitForQaTransportCondition,
      resolveGeneratedImagePath: async () => generatedPath,
      formatTransportTranscript,
      readSessionTranscriptSummary: async () => {
        if (options.fault === "late duplicate message") {
          deliverImage();
        }
        return {
          successfulToolCallCounts: { image_generate: options.isGenerating ? 2 : 1 },
          finalText: settled ? caption : "Rendering the lighthouse.",
        };
      },
      runScenario: runQaSuiteScenarioSteps,
    },
  });
}

describe("native image scenario delivery evidence", () => {
  it("correlates the public task receipt without private details after image completion", async () => {
    vi.useFakeTimers();
    const waiting = createDeferred<"waiting">();
    let active = true;
    observeStatusWait.mockImplementationOnce(() => waiting.resolve("waiting"));
    const result = runImageScenario({ isGenerating: () => active });
    try {
      expect(await Promise.race([waiting.promise, result])).toBe("waiting");
    } finally {
      active = false;
      await vi.runAllTimersAsync();
      await result;
      observeStatusWait.mockReset();
      vi.useRealTimers();
    }
    const outcome = await result;
    expect(outcome, outcome.details).toMatchObject({ status: "pass" });
  });

  it.each([
    ["late duplicate message", "expected exactly one generated-image delivery"],
    ["failed turn", "agent.wait returned error: image generation failed"],
  ] as const)("rejects %s", async (fault, error) => {
    expect(await runImageScenario({ fault })).toMatchObject({
      status: "fail",
      details: expect.stringContaining(error),
    });
  });

  it.each([
    "initial acknowledgement only",
    "wrong completion run",
    "mismatched completion text",
  ] as const)("rejects %s as completion evidence", async (fault) => {
    expect(await runImageScenario({ fault })).toMatchObject({
      status: "fail",
      details: expect.stringContaining("generated image completion was not persisted"),
    });
  });
});
