import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { encodePngRgba, fillPixel } from "../../media/png-encode.js";
import type { Agent, AgentMessage } from "../runtime/index.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { createImageTool } from "../tools/image-tool.js";
import {
  estimateMessageCharsCached as estimateChars,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
} from "./tool-result-char-estimator.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

function makeDistinctImageRef(index: number): string {
  const width = 64;
  const pixels = Buffer.alloc(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(pixels, x, y, width, (index + 1) * 17, x * 3, y * 3);
    }
  }
  return `data:image/png;base64,${encodePngRgba(pixels, width, width).toString("base64")}`;
}

async function executeNativeImageTool(imageCount: number): Promise<AgentMessage> {
  const tool = expectDefined(
    createImageTool({
      config: { agents: { defaults: { imageMaxDimensionPx: 32 } } },
      agentDir: join(tmpdir(), "openclaw-native-image-context-test"),
      modelHasVision: true,
    }),
    "native-vision image tool is available",
  );
  const result = await tool.execute("native-image-context", {
    paths: Array.from({ length: imageCount }, (_, index) => makeDistinctImageRef(index)),
  });
  expect(result.content.filter((block) => block.type === "image")).toHaveLength(imageCount);
  return castAgentMessage({
    role: "toolResult",
    toolCallId: "native-image-context",
    toolName: "view_image",
    isError: false,
    timestamp: 0,
    ...result,
  });
}

async function projectForContext(source: AgentMessage, contextWindowTokens = 32_000) {
  const agent: Pick<Agent, "transformContext"> = {};
  installToolResultContextGuard({ agent, contextWindowTokens });
  const transform = expectDefined(agent.transformContext, "installed context guard");
  const [result] = await transform([source], new AbortController().signal);
  const projected = expectDefined(result, "guarded native image result");
  const existingCap = Math.max(
    1_024,
    Math.floor(contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * 0.5),
  );
  expect(estimateChars(projected, new WeakMap<AgentMessage, number>())).toBeLessThanOrEqual(
    existingCap,
  );
  expect(projected).not.toHaveProperty("details");
  const content = blocksOf(projected);
  return { projected, content, images: content.filter((block) => block.type === "image") };
}

function blocksOf(message: AgentMessage): ContentBlock[] {
  return (message as { content: ContentBlock[] }).content;
}

it("explains when no sanitized image fits the context window", async () => {
  const source = await executeNativeImageTool(1);
  const originalSnapshot = structuredClone(source);
  const { content, images } = await projectForContext(source, 8_000);
  const projectedText = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  expect(images).toEqual([]);
  expect(projectedText).toMatch(/1 image .*omitted|omitted.*1 image/i);
  expect(projectedText).toMatch(/context/i);
  expect(projectedText).toMatch(
    /no images? (?:fit|included|available)|images? (?:could not|cannot) (?:fit|be included)/i,
  );
  expect(source).toEqual(originalSnapshot);
  expect(source).toMatchObject({ details: { media: { outbound: false } } });
});

it("preserves mixed text, unknown blocks, CJK content, image order, and original privacy", async () => {
  const native = await executeNativeImageTool(3);
  const nativeBlocks = blocksOf(native);
  const unknown = { type: "custom", value: { label: "bounded metadata" } };
  const cjk = { type: "text", text: "画像の順序を維持する 🖼️" };
  const source = castAgentMessage({
    ...native,
    toolName: "read",
    content: [nativeBlocks[0], nativeBlocks[1], unknown, cjk, nativeBlocks[2], nativeBlocks[3]],
    details: { media: { outbound: false }, privateReference: "private-fixture-reference" },
  });
  const { content, images } = await projectForContext(source);

  expect(images).toEqual([nativeBlocks[1]]);
  expect(content.map((block) => block.type)).toEqual(["text", "image", "custom", "text", "text"]);
  expect(content).toContain(unknown);
  expect(content).toContain(cjk);
  expect(content.at(-1)?.text).toMatch(/2 images? .*omitted|omitted.*2 images?/i);
  expect(JSON.stringify(content)).not.toContain("private-fixture-reference");
  expect(source).toMatchObject({ details: { media: { outbound: false } } });
});

it.each([false, true])(
  "retains an image beside CJK text (trailing block: %s)",
  async (trailing) => {
    const native = await executeNativeImageTool(trailing ? 2 : 1);
    const nativeBlocks = blocksOf(native);
    const trailingText = { type: "text", text: "d".repeat(2_000) };
    const source = castAgentMessage({
      ...native,
      content: [
        { type: "text", text: "画像🖼️".repeat(8_000) },
        nativeBlocks[1],
        ...(trailing ? [trailingText, nativeBlocks[2]] : nativeBlocks.slice(2)),
      ],
    });
    const { content, images } = await projectForContext(source);

    expect(images).toEqual([nativeBlocks[1]]);
    const boundedText = expectDefined(content[0]?.text, "bounded image context text");
    expect(Buffer.from(boundedText, "utf8").toString("utf8")).toBe(boundedText);
    if (trailing) {
      expect(content).toContainEqual(trailingText);
      expect(content.at(-1)?.text).toContain("1 image omitted");
    } else {
      expect(boundedText).toContain("画像");
      expect(content.some((block) => block.text?.includes("0 images"))).toBe(false);
      expect(blocksOf(source).filter((block) => block.type === "image")).toHaveLength(1);
    }
  },
);
