/**
 * Integration test: Gateway multimodal input pipeline.
 *
 * Simulates the full path from a gateway client sending base64 image
 * attachments via `chat.send` RPC, through model resolution, to the
 * image array that gets passed to the model prompt.
 *
 * Covers the fix for: OpenRouter fallback models dropping images because
 * `input` was `["text"]` instead of `["text", "image"]`, and
 * `detectAndLoadPromptImages` discarding explicitly-provided images
 * when the model doesn't advertise native vision support.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMessageWithAttachments } from "../../../gateway/chat-attachments.js";
import { normalizeRpcAttachmentsToChatAttachments } from "../../../gateway/server-methods/attachment-normalize.js";
import { detectAndLoadPromptImages, modelSupportsImages } from "./images.js";

vi.mock("../../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import { resolveModel } from "../model.js";
import { resetMockDiscoverModels } from "../model.test-harness.js";

beforeEach(() => {
  resetMockDiscoverModels();
});

const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

describe("gateway multimodal input: full pipeline integration", () => {
  it("OpenRouter model resolution includes image capability for unknown model IDs", () => {
    const { model } = resolveModel("openrouter", "anthropic/claude-opus-4.6", "/tmp/agent");

    expect(model).toBeDefined();
    expect(model!.input).toContain("image");
    expect(model!.input).toContain("text");
    expect(model!.api).toBe("openai-completions");
    expect(model!.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(modelSupportsImages(model!)).toBe(true);
  });

  it("full pipeline: RPC attachment → parse → model resolve → image injection (OpenRouter)", async () => {
    // Step 1: Simulate gateway client (e.g. ClawX) sending RPC with base64 attachment
    const rpcAttachments = [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "chrome-logo.png",
        content: PNG_1x1_BASE64,
      },
    ];

    // Step 2: Gateway normalizes RPC attachments
    const normalized = normalizeRpcAttachmentsToChatAttachments(rpcAttachments);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].content).toBe(PNG_1x1_BASE64);

    // Step 3: Gateway parses message with attachments
    const parsed = await parseMessageWithAttachments("What is this logo?", normalized, {
      log: { warn: () => {} },
    });
    expect(parsed.message).toBe("What is this logo?");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].type).toBe("image");
    expect(parsed.images[0].mimeType).toBe("image/png");
    expect(parsed.images[0].data).toBe(PNG_1x1_BASE64);

    // Step 4: Model resolution for OpenRouter
    const { model } = resolveModel("openrouter", "anthropic/claude-opus-4.6", "/tmp/agent");
    expect(model).toBeDefined();
    expect(modelSupportsImages(model!)).toBe(true);

    // Step 5: detectAndLoadPromptImages (embedded runner)
    const imageResult = await detectAndLoadPromptImages({
      prompt: "What is this logo?",
      workspaceDir: "/tmp",
      model: model!,
      existingImages: parsed.images,
    });

    // VERIFY: images reach the model
    expect(imageResult.images).toHaveLength(1);
    expect(imageResult.images[0].type).toBe("image");
    expect(imageResult.images[0].data).toBe(PNG_1x1_BASE64);
    expect(imageResult.images[0].mimeType).toBe("image/png");
  });

  it("full pipeline: existingImages survive even for text-only model definition", async () => {
    // Simulate a model that doesn't advertise image support
    const textOnlyModel = { input: ["text"] };

    // Gateway parsed images (from RPC attachments)
    const gatewayImages = [{ type: "image" as const, data: PNG_1x1_BASE64, mimeType: "image/png" }];

    // detectAndLoadPromptImages should STILL pass through existingImages
    const imageResult = await detectAndLoadPromptImages({
      prompt: "What is this logo?",
      workspaceDir: "/tmp",
      model: textOnlyModel,
      existingImages: gatewayImages,
    });

    expect(imageResult.images).toHaveLength(1);
    expect(imageResult.images[0].data).toBe(PNG_1x1_BASE64);
  });

  it("multiple images from gateway client all reach the model", async () => {
    const rpcAttachments = [
      { type: "image", mimeType: "image/png", fileName: "img1.png", content: PNG_1x1_BASE64 },
      { type: "image", mimeType: "image/png", fileName: "img2.png", content: PNG_1x1_BASE64 },
    ];

    const normalized = normalizeRpcAttachmentsToChatAttachments(rpcAttachments);
    const parsed = await parseMessageWithAttachments("Compare these images", normalized, {
      log: { warn: () => {} },
    });
    expect(parsed.images).toHaveLength(2);

    const { model } = resolveModel("openrouter", "anthropic/claude-opus-4.6", "/tmp/agent");
    const imageResult = await detectAndLoadPromptImages({
      prompt: "Compare these images",
      workspaceDir: "/tmp",
      model: model!,
      existingImages: parsed.images,
    });

    expect(imageResult.images).toHaveLength(2);
  });
});
