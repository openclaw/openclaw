import assert from "node:assert/strict";
import { beforeAll, describe, expect, it } from "vitest";
import { labelRuntimeContextText } from "../llm/types.js";
import { isRecord } from "../plugin-sdk/string-coerce-runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  buildAgentInternalEventContext,
  formatGeneratedMediaDeliveredForPrompt,
  resolveAcpPromptBody,
  type AgentInternalEvent,
} from "./internal-events.js";
import { projectRuntimeContextFragments } from "./internal-runtime-context.js";

const event: AgentInternalEvent = {
  type: "task_completion",
  source: "image_generation",
  childSessionKey: "image_generate:qa-image",
  childSessionId: "qa-image",
  announceType: "image generation task",
  taskLabel: "A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
  status: "ok",
  statusLabel: "completed successfully",
  result: "Generated 1 image.",
  mediaUrls: ["/tmp/qa-lighthouse.png"],
  replyInstruction: "Review the generated image and reply briefly.",
};
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
type QaProviderApi = {
  startQaMockOpenAiServer: () => Promise<{ baseUrl: string; stop: () => Promise<void> }>;
};

describe("image completion producer context through the QA provider", () => {
  let startQaMockOpenAiServer: QaProviderApi["startQaMockOpenAiServer"];
  beforeAll(async () => {
    ({ startQaMockOpenAiServer } = await loadBundledPluginFacade<QaProviderApi>({
      pluginId: "qa-lab",
      artifactBasename: "api.js",
    }));
  });

  it.each(["v4 developer", "queued host delivery"] as const)(
    "recognizes %s without replaying an unavailable image tool",
    async (projection) => {
      const server = await startQaMockOpenAiServer();
      try {
        const completion =
          projection === "v4 developer"
            ? {
                role: "developer",
                content: labelRuntimeContextText(
                  projectRuntimeContextFragments(buildAgentInternalEventContext([event])),
                ),
              }
            : user(
                `${formatGeneratedMediaDeliveredForPrompt(event.mediaUrls ?? [])}\n\n${resolveAcpPromptBody("", [event])}`,
              );
        const provenance = labelRuntimeContextText(
          projectRuntimeContextFragments([
            {
              kind: "conversation-data",
              text: "[Inter-session message] sourceSession=image_generate:qa-image sourceChannel=internal sourceTool=image_generate isUser=false",
            },
          ]),
        );
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.6-luna",
            stream: false,
            instructions: "Read source and docs; report worked, failed, blocked.",
            tools: [{ type: "function", name: "message" }],
            input: [
              user("Image generation check: generate a QA lighthouse image."),
              {
                type: "function_call",
                name: "image_generate",
                call_id: "qa-image",
                arguments: JSON.stringify({ prompt: "A QA lighthouse" }),
              },
              {
                type: "function_call_output",
                call_id: "qa-image",
                output: JSON.stringify({
                  content: [{ type: "text", text: "Background image generation started." }],
                  details: { async: true, status: "started" },
                }),
              },
              completion,
              ...(projection === "queued host delivery" ? [user(provenance)] : []),
            ],
          }),
        });
        expect(response.ok).toBe(true);
        const result: unknown = await response.json();
        assert.ok(isRecord(result) && Array.isArray(result.output));
        expect(result.output.some((item) => isRecord(item) && item.type === "function_call")).toBe(
          false,
        );
        const text = result.output
          .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
          .flatMap((part) =>
            isRecord(part) && part.type === "output_text" && typeof part.text === "string"
              ? [part.text]
              : [],
          )
          .join("");
        expect(text).toBe(
          "Protocol note: generated the QA lighthouse image successfully." +
            (projection === "queued host delivery" ? "" : "\nMEDIA:/tmp/qa-lighthouse.png"),
        );
      } finally {
        await server.stop();
      }
    },
  );
});
