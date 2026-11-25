import { expectDefined } from "@openclaw/normalization-core";
import type { ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { serializeCacheTtlToolResultProjections } from "./cache-ttl-checkpoint.js";
import { createToolResultPromptProjectionState } from "./session-prompt-state.js";
import { getToolResultText } from "./tool-result-char-estimator.js";
import {
  applyGuardToContext,
  makeGuardableAgent,
} from "./tool-result-context-guard.test-support.js";
import {
  restoreCacheTtlToolResultProjections,
  truncateOversizedToolResultsInMessages,
} from "./tool-result-truncation.js";

const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=",
};

function mixedResult(): ToolResultMessage {
  const rows = Array.from({ length: 1_000 }, (_, index) => ({
    type: "text" as const,
    text: "record-" + String(index + 1).padStart(4, "0") + " | " + "payload ".repeat(14).trimEnd(),
  }));
  return {
    role: "toolResult",
    toolCallId: "interleaved-page",
    toolName: "records",
    isError: false,
    timestamp: 1,
    content: [...rows.slice(0, 70), image, ...rows.slice(70)],
  };
}

it("does not re-expand a compacted text prefix after relaxation or checkpoint restoration", () => {
  const source = mixedResult();
  const state = createToolResultPromptProjectionState();
  const project = (cap: number, target = state) =>
    expectDefined(
      truncateOversizedToolResultsInMessages([source], 32_768, cap, 100_000, target).messages[0],
      "projected result",
    );
  const first = project(16_000);
  const tight = project(8_000);
  expect(getToolResultText(first)).toContain("record-0064");
  expect(getToolResultText(tight)).toContain("record-0063");
  expect(getToolResultText(tight)).not.toContain("record-0064");
  expect(project(16_000)).toEqual(tight);

  const restarted = createToolResultPromptProjectionState();
  const checkpointJson = JSON.stringify(serializeCacheTtlToolResultProjections(state));
  const data: unknown = JSON.parse(checkpointJson);
  restoreCacheTtlToolResultProjections(restarted, [
    { type: "custom", customType: "openclaw.cache-ttl", data },
  ]);
  expect(project(16_000, restarted)).toEqual(tight);
  expect(source.content).toHaveLength(1_001);
});

it("keeps a fitting image in the model context along with compacted text", async () => {
  const source = mixedResult();
  const guarded = expectDefined(
    await applyGuardToContext(makeGuardableAgent(), [source], 32_768),
    "guarded messages",
  );
  const result = expectDefined(guarded[0], "guarded result");
  if (result.role !== "toolResult") {
    throw new Error("Expected a tool result");
  }
  const text = getToolResultText(result);
  expect(result.content.filter((block) => block.type === "image")).toEqual([image]);
  expect(text).toContain("record-0001");
  expect(text.match(/more characters truncated/gu)).toHaveLength(1);
  expect(text).not.toContain("image omitted");
});
