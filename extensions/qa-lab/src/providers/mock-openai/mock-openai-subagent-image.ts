import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import { extractCurrentRuntimeContextTexts, extractLatestToolOutput } from "./mock-openai-input.js";

const QA_SUBAGENT_IMAGE_PARENT_MARKER = "Subagent image QA parent";
const QA_SUBAGENT_IMAGE_CHILD_MARKER = "Subagent image QA child";
const QA_SUBAGENT_IMAGE_CHILD_RESULT = "QA-SUBAGENT-IMAGE-CHILD-DONE";
const QA_SUBAGENT_IMAGE_PARENT_RELAY = "QA-SUBAGENT-IMAGE-PARENT-RELAY";

function inputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : "";
}

function mediaLines(text: string): string[] {
  return text.match(/^MEDIA:\S+$/gmu) ?? [];
}

/**
 * Scripts a parent that delegates image generation to a one-shot subagent and relays the
 * child's announced result, media lines included.
 */
export function planSubagentImageTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  const event = [params.prompt, ...extractCurrentRuntimeContextTexts(params.input)].join("\n");
  if (
    params.prompt.includes("sourceTool=subagent_announce") &&
    event.includes(QA_SUBAGENT_IMAGE_CHILD_RESULT)
  ) {
    return buildAssistantEvents([QA_SUBAGENT_IMAGE_PARENT_RELAY, ...mediaLines(event)].join("\n"));
  }
  const marker = [QA_SUBAGENT_IMAGE_CHILD_MARKER, QA_SUBAGENT_IMAGE_PARENT_MARKER].find((value) =>
    params.prompt.includes(value),
  );
  const start = params.input.findLastIndex(
    (item) =>
      item.role === "user" && marker !== undefined && inputText(item.content).includes(marker),
  );
  const completed = params.input
    .slice(start + 1)
    .filter((item) => item.type === "function_call_output").length;
  if (marker === QA_SUBAGENT_IMAGE_CHILD_MARKER) {
    if (completed === 0) {
      return params.buildToolCall("image_generate", {
        prompt: "A QA lighthouse for the subagent image check.",
        filename: "qa-subagent-lighthouse.png",
        size: "1024x1024",
      });
    }
    // Report generated files with the prompt's MEDIA directive, as the subagent result contract asks.
    const paths = [...extractLatestToolOutput(params.input).matchAll(/path=\\?"([^"\\]+)\\?"/gu)];
    return buildAssistantEvents(
      [QA_SUBAGENT_IMAGE_CHILD_RESULT, ...paths.map((match) => `MEDIA:${match[1]}`)].join("\n"),
    );
  }
  if (marker === QA_SUBAGENT_IMAGE_PARENT_MARKER) {
    return completed === 0
      ? params.buildToolCall("sessions_spawn", {
          task: `${QA_SUBAGENT_IMAGE_CHILD_MARKER}: generate the QA lighthouse image.`,
          label: "qa-image-child",
          mode: "run",
        })
      : buildAssistantEvents("Started an image worker.");
  }
  return null;
}
