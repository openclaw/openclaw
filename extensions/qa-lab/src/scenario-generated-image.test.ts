import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { extractGatewayMessageText } from "./gateway-log-sentinel.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { runAgentPrompt } from "./suite-runtime-agent-process.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import { formatTransportTranscript, waitForOutboundMessage } from "./suite-runtime-transport.js";

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
const textContent = (text: string) => [{ type: "text", text }];

function imageToolExchange(action: string, index: number, taskId: string) {
  const id = `image-${index}`;
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "image_generate", arguments: { action } }],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "image_generate",
      isError: false,
      content:
        action === "generate"
          ? textContent(
              `Background task started for image generation (${taskId}). Do not call image_generate again for this request.`,
            )
          : [],
    },
  ];
}

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
  const reply = (text: string) => state.addOutboundMessage({ to: "dm:qa-operator", text });
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
          expect(params).toMatchObject({
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
          expect(params).toMatchObject({ sessionKey });
          return {
            messages: [
              ...["status", "generate", "status"].flatMap((action, index) =>
                imageToolExchange(action, index, taskId),
              ),
              ...(options.fault === "initial acknowledgement only"
                ? []
                : [
                    {
                      role: "assistant",
                      content: textContent(caption),
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
            reply(
              options.fault === "initial acknowledgement only"
                ? caption
                : "Rendering the lighthouse.",
            );
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
          reply(options.fault === "mismatched completion text" ? "Unpersisted caption." : caption);
        }
        return {
          status: "ok",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReply: { disposition: "visible", text: caption },
        };
      },
    },
    transport: { buildAgentDelivery: () => ({ channel: "qa-channel", to: "dm:qa-operator" }) },
    mock: null,
  };
  return runLoadedScenarioFlow("native-image-generation", {
    state,
    api: {
      env,
      fs,
      ensureImageGenerationConfigured: async () => {},
      createSession: async () => sessionKey,
      normalizeLowercaseStringOrEmpty,
      extractGatewayMessageText,
      readEffectiveTools: async () => new Set(["image_generate"]),
      runAgentPrompt,
      waitForOutboundMessage,
      waitForCondition: waitForQaTransportCondition,
      resolveGeneratedImagePath: async () => generatedPath,
      formatTransportTranscript,
      readSessionTranscriptSummary: async () => {
        if (options.fault === "late duplicate message") {
          deliverImage();
        }
        return {
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
