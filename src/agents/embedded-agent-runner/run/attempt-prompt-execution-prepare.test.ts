import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { beforeEach, expect, it, vi } from "vitest";

const { detectAndLoadPromptImages } = vi.hoisted(() => ({
  detectAndLoadPromptImages: vi.fn(),
}));

// mock-isolation: Supply image-load results without reading media or starting image tooling.
vi.mock("./images.js", () => ({
  detectAndLoadPromptImages,
}));

import { prepareEmbeddedAttemptPromptExecution as prepare } from "./prompt-image-preparation.js";

type PromptExecutionInput = Parameters<typeof prepare>[0];
type ImageResult = Awaited<ReturnType<typeof prepare>>;

function imageResult(overrides: Partial<ImageResult> = {}): ImageResult {
  return {
    images: [],
    imageFactIndexes: [],
    detectedRefs: [],
    failedMediaCount: 0,
    loadedCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}
const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });

function createInput(
  overrides: Partial<PromptExecutionInput> = {},
  attempt: Partial<PromptExecutionInput["attempt"]> = {},
): PromptExecutionInput {
  const fsBridge = { readFile: vi.fn() };
  return {
    attempt: {
      workspaceDir: "/agent/workspace",
      config: { agents: { defaults: { imageMaxDimensionPx: 2048 } } },
      imageOrder: ["inline"],
      images: [image("data")],
      model: { input: ["text", "image"] },
      ...attempt,
    },
    effectiveFsWorkspaceOnly: true,
    effectiveWorkspace: "/tmp/workspace",
    prompt: "inspect image.png",
    sandbox: { enabled: true, fsBridge, workspaceDir: "/sandbox/workspace" },
    skipPromptSubmission: false,
    ...overrides,
  } as PromptExecutionInput;
}

const loadedResult = imageResult({
  images: [image("loaded")],
  imageFactIndexes: [null],
  loadedCount: 1,
});
beforeEach(() => {
  vi.clearAllMocks();
  detectAndLoadPromptImages.mockResolvedValue(structuredClone(loadedResult));
});

it("returns an isolated empty image result when prompt submission is already skipped", async () => {
  const first = await prepare(createInput({ skipPromptSubmission: true }));
  first.images.push(image("mutated"));
  const second = await prepare(createInput({ skipPromptSubmission: true }));

  expect(second).toEqual(imageResult());
  expect(detectAndLoadPromptImages).not.toHaveBeenCalled();
});

it.each([true, false])(
  "loads prompt images with workspace policy (sandbox: %s)",
  async (sandbox) => {
    const input = createInput(sandbox ? {} : { sandbox: null });

    const result = await prepare(input);

    expect(detectAndLoadPromptImages).toHaveBeenCalledWith({
      prompt: "inspect image.png",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/agent/workspace",
      model: input.attempt.model,
      existingImages: input.attempt.images,
      imageOrder: ["inline"],
      maxBytes: MAX_IMAGE_BYTES,
      maxDimensionPx: 2048,
      workspaceOnly: true,
      sandbox: sandbox
        ? { root: "/sandbox/workspace", bridge: input.sandbox?.fsBridge }
        : undefined,
    });
    expect(result).toEqual(loadedResult);
  },
);
