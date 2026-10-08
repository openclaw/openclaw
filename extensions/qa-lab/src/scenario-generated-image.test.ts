import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { mergeAttemptToolMediaPayloads } from "openclaw/plugin-sdk/qa-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import type { QaRuntimeSelection } from "./runtime-id.js";
import type { requireToolSearchDiscoveryEvidence } from "./runtime-tool-search-evidence.js";
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

type ImageFault =
  | "duplicate message"
  | "late duplicate message"
  | "duplicate attachment"
  | "wrong bytes"
  | "empty bytes"
  | "empty file"
  | "missing tool completion"
  | "status only"
  | "duplicate generation"
  | "missing persisted reply"
  | "persisted progress only"
  | "wrong caption"
  | "unrelated markdown"
  | "failed turn";

async function runImageScenario(
  options: {
    progress?: boolean;
    fault?: ImageFault;
    isGenerating?: () => boolean;
    liveCodexDiscovery?: "present" | "missing";
    runtimeId?: "openclaw" | "codex";
    runtimeSelection?: QaRuntimeSelection;
    replyFormat?: "media-directive" | "markdown";
  } = {},
) {
  const scenario = readQaScenarioById("native-image-generation");
  if (!scenario.execution.flow) {
    throw new Error("expected native image flow");
  }
  const state = createQaBusState();
  const generatedPath = path.join(tempDirs.make("qa-generated-image-"), "generated.png");
  await fs.writeFile(generatedPath, options.fault === "empty file" ? Buffer.alloc(0) : png);
  const caption = "A QA lighthouse on the coast.";
  const finalText =
    options.replyFormat === "markdown"
      ? `${caption}\n\n![QA lighthouse](${generatedPath})`
      : `${caption}\n\nMEDIA:${generatedPath}`;
  const [delivery] = createOutboundPayloadPlan(
    mergeAttemptToolMediaPayloads({
      payloads: [{ text: finalText }],
      toolMediaUrls: [generatedPath],
    }) ?? [],
  );
  assert.ok(delivery);
  expect(delivery.parts).toMatchObject({ text: caption, mediaUrls: [generatedPath] });
  const attachment = {
    id: "generated-image",
    kind: "image" as const,
    mimeType: "image/png",
    contentBase64:
      options.fault === "wrong bytes"
        ? Buffer.from("wrong image bytes").toString("base64")
        : options.fault === "empty bytes"
          ? ""
          : png.toString("base64"),
  };
  let completed = false;
  let settled = false;
  const sessionKey = "agent:qa:image-generate:test";
  const env = {
    providerMode: "live-frontier",
    runtimeId: options.runtimeId ?? (options.liveCodexDiscovery ? "codex" : "openclaw"),
    runtimeSelection:
      options.runtimeSelection ?? (options.liveCodexDiscovery ? "configured" : undefined),
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
          const actions =
            options.fault === "status only"
              ? ["status"]
              : options.fault === "duplicate generation"
                ? ["generate", "generate"]
                : ["status", "generate", "status"];
          return {
            messages: actions.flatMap((action, index) => {
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
              if (options.fault === "missing tool completion" && action === "generate") {
                return [call];
              }
              return [
                call,
                {
                  role: "toolResult",
                  toolCallId: `image-${index}`,
                  toolName: "image_generate",
                  isError: false,
                },
              ];
            }),
          };
        }
        if (method === "agent") {
          if (options.progress) {
            state.addOutboundMessage({ to: "dm:qa-operator", text: "Rendering the lighthouse." });
          }
          return { runId: "image-run" };
        }
        if (method !== "agent.wait") {
          throw new Error(`unexpected RPC: ${method}`);
        }
        if (options.fault === "failed turn") {
          return { status: "error", error: "image generation failed" };
        }
        for (let i = 0; i < (options.fault === "duplicate message" ? 2 : 1); i++) {
          state.addOutboundMessage({
            to: "dm:qa-operator",
            text: options.fault === "wrong caption" ? "A different caption." : delivery.parts.text,
            attachments:
              options.fault === "duplicate attachment"
                ? [attachment, { ...attachment, id: "duplicate" }]
                : [attachment],
          });
        }
        completed = true;
        return {
          status: "ok",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReply: { disposition: "visible", text: "A QA lighthouse on the coast." },
        };
      },
    },
    transport: { buildAgentDelivery: () => ({ channel: "qa-channel", to: "dm:qa-operator" }) },
    primaryModel: options.liveCodexDiscovery ? "openai/gpt-5.5" : undefined,
    mock: null,
  };
  const result = await runScenarioFlow({
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
      readEffectiveTools: async () => new Set(["image_generate"]),
      requireToolSearchDiscoveryEvidence: async (
        envArg: unknown,
        evidence: Parameters<typeof requireToolSearchDiscoveryEvidence>[1],
      ) => {
        expect(envArg).toBe(env);
        expect(evidence).toEqual({
          sessionKey,
          toolName: "image_generate",
          expectedCallId: "image-1",
          expectedSuccess: true,
        });
        if (options.liveCodexDiscovery === "missing") {
          throw new Error("expected live happy-path tool_search discovery for image_generate");
        }
        return { searchCallId: "search-image" };
      },
      formatToolSearchDiscoveryReceipt: (phase: string, receipt: { searchCallId: string }) =>
        `phase=${phase} search=${receipt.searchCallId}`,
      reset: () => state.reset(),
      runAgentPrompt,
      liveTurnTimeoutMs: (_env: unknown, value: number) => value,
      waitForOutboundMessage,
      waitForCondition: waitForQaTransportCondition,
      resolveGeneratedImagePath: async () => generatedPath,
      formatTransportTranscript,
      readSessionTranscriptSummary: async () => {
        if (options.fault === "late duplicate message") {
          state.addOutboundMessage({
            to: "dm:qa-operator",
            text: "A QA lighthouse on the coast.",
            attachments: [attachment],
          });
        }
        return {
          successfulToolCallCounts:
            completed && options.fault !== "missing tool completion"
              ? {
                  image_generate:
                    options.progress || options.fault === "duplicate generation" ? 2 : 1,
                }
              : {},
          finalText:
            options.fault === "missing persisted reply"
              ? ""
              : !settled || options.fault === "persisted progress only"
                ? "Rendering the lighthouse."
                : options.fault === "unrelated markdown"
                  ? `${finalText}\n\n![Unrelated image](/unrelated.png)`
                  : finalText,
        };
      },
      runScenario: runQaSuiteScenarioSteps,
    },
  });
  return result;
}

describe("native image scenario delivery evidence", () => {
  it.each([false, true])(
    "accepts one exact image after completion (progress=%s)",
    async (progress) => {
      if (!progress) {
        expect(await runImageScenario()).toMatchObject({ status: "pass" });
        return;
      }
      vi.useFakeTimers();
      const waiting = createDeferred<"waiting">();
      let active = true;
      observeStatusWait.mockImplementationOnce(() => waiting.resolve("waiting"));
      const result = runImageScenario({ progress, isGenerating: () => active });
      try {
        expect(await Promise.race([waiting.promise, result])).toBe("waiting");
      } finally {
        active = false;
        await vi.runAllTimersAsync();
        await result;
        observeStatusWait.mockReset();
        vi.useRealTimers();
      }
      expect(await result).toMatchObject({ status: "pass" });
    },
  );

  it("accepts direct OpenClaw image generation without Codex discovery", async () => {
    await expect(
      runImageScenario({ runtimeId: "openclaw", liveCodexDiscovery: "missing" }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("compares persisted generated-attachment Markdown using the delivered caption", async () => {
    const result = await runImageScenario({
      replyFormat: "markdown",
      liveCodexDiscovery: "present",
    });
    expect(result, result.details).toMatchObject({ status: "pass" });
  });

  it("accepts forced Codex image generation without discovery receipts", async () => {
    await expect(
      runImageScenario({
        runtimeId: "codex",
        runtimeSelection: "forced",
        liveCodexDiscovery: "missing",
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("requires linked searchable discovery for configured live Codex image generation", async () => {
    await expect(runImageScenario({ liveCodexDiscovery: "missing" })).resolves.toMatchObject({
      status: "fail",
      details: expect.stringContaining(
        "expected live happy-path tool_search discovery for image_generate",
      ),
    });
    const result = await runImageScenario({ liveCodexDiscovery: "present" });
    expect(result).toMatchObject({ status: "pass" });
    expect(result.steps?.[0]?.details).toContain(
      "image_generate tool_search discovery phase=happy search=search-image",
    );
  });

  it.each([
    ["duplicate message", "expected exactly one generated-image delivery"],
    ["late duplicate message", "expected exactly one generated-image delivery"],
    ["duplicate attachment", "expected exactly one generated-image delivery"],
    ["wrong bytes", "expected exactly one generated-image delivery"],
    ["empty bytes", "expected exactly one generated-image delivery"],
    ["empty file", "image generation did not produce a nonempty saved media file"],
    ["missing tool completion", "generated image completion was not persisted"],
    ["status only", "generated image completion was not persisted"],
    ["duplicate generation", "generated image completion was not persisted"],
    ["missing persisted reply", "generated image completion was not persisted"],
    ["persisted progress only", "generated image completion was not persisted"],
    ["wrong caption", "generated image completion was not persisted"],
    ["unrelated markdown", "generated image completion was not persisted"],
    ["failed turn", "agent.wait returned error: image generation failed"],
  ] as const)("rejects %s", async (fault, error) => {
    expect(await runImageScenario({ fault })).toMatchObject({
      status: "fail",
      details: expect.stringContaining(error),
    });
  });
});
