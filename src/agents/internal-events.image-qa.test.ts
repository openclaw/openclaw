import { beforeAll, describe, expect, it } from "vitest";
import { labelRuntimeContextText } from "../llm/types.js";
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

  it.each([
    "v4 developer",
    "v4 host delivery",
    "v4 quoted delivery",
    "queued host delivery",
  ] as const)("recognizes %s without replaying an unavailable image tool", async (projection) => {
    const server = await startQaMockOpenAiServer();
    try {
      const deliveredMediaContext = formatGeneratedMediaDeliveredForPrompt(event.mediaUrls ?? []);
      const completionEvent =
        projection === "v4 host delivery"
          ? { ...event, replyInstruction: `${event.replyInstruction}\n\n${deliveredMediaContext}` }
          : event;
      const completion =
        projection !== "queued host delivery"
          ? {
              role: "developer",
              content: labelRuntimeContextText(
                projectRuntimeContextFragments(
                  buildAgentInternalEventContext(
                    [completionEvent],
                    projection === "v4 quoted delivery"
                      ? [{ kind: "conversation-data", text: deliveredMediaContext }]
                      : [],
                  ),
                ),
              ),
            }
          : user(`${deliveredMediaContext}\n\n${resolveAcpPromptBody("", [event])}`);
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
          tools: [{ type: "function", name: "message" }],
          input: [
            user("Image generation check: generate a QA lighthouse image."),
            {
              type: "function_call",
              name: "image_generate",
              call_id: "qa-image",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "qa-image",
              output: "Background image generation started.",
            },
            completion,
            ...(projection === "queued host delivery" ? [user(provenance)] : []),
          ],
        }),
      });
      expect(response.ok).toBe(true);
      const text =
        "Protocol note: generated the QA lighthouse image successfully." +
        (projection === "queued host delivery" || projection === "v4 host delivery"
          ? ""
          : "\nMEDIA:/tmp/qa-lighthouse.png");
      expect(await response.json()).toMatchObject({
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      });
    } finally {
      await server.stop();
    }
  });
});
