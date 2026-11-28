import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { LlamaCppHardware } from "./hardware.js";
import {
  LLAMA_CPP_MEDIA_RECIPES,
  recommendLlamaCppMedia,
  resolveLlamaCppMediaArtifact,
} from "./media-catalog.js";

const GIB = 1024 ** 3;

function hardware(overrides: Partial<LlamaCppHardware> = {}): LlamaCppHardware {
  return {
    platform: "linux",
    arch: "x64",
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 7 * GIB,
    availableDiskBytes: 100 * GIB,
    availableRuntimeDiskBytes: 100 * GIB,
    sharedDisk: true,
    accelerator: { kind: "cpu", reason: "CPU host" },
    ...overrides,
  };
}

describe("managed local media catalog", () => {
  it("pins every model and matching projector to immutable verified downloads", () => {
    expect(new Set(LLAMA_CPP_MEDIA_RECIPES.map((recipe) => recipe.capability))).toEqual(
      new Set(["ocr", "vision"]),
    );
    for (const recipe of LLAMA_CPP_MEDIA_RECIPES) {
      const [repository, revision]: [string, string] =
        recipe.capability === "ocr"
          ? ["ggml-org/GLM-OCR-GGUF", "65a42de1148dbed2297e922b5dbc7d9b70c36578"]
          : recipe.id === "smolvlm2-500m-video-instruct-q8_0"
            ? [
                "ggml-org/SmolVLM2-500M-Video-Instruct-GGUF",
                "ccd7aae53bcb1997355c2f094959e72b3642ce17",
              ]
            : ["ggml-org/SmolVLM2-2.2B-Instruct-GGUF", "1bc3c9f74ceafd4c8d4411cc9cf188bba3798f91"];
      for (const artifact of [recipe.model, recipe.projector]) {
        expect(artifact).toMatchObject({
          source: `hf:${repository}/${artifact.filename}#${revision}`,
          expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          url: `https://huggingface.co/${repository}/resolve/${revision}/${artifact.filename}?download=true`,
        });
        expect(artifact.expectedSize).toBeGreaterThan(0);
        expect(resolveLlamaCppMediaArtifact(artifact.source)).toBe(artifact);
        expect(
          resolveLlamaCppMediaArtifact(artifact.source.replace(revision, "main")),
        ).toBeUndefined();
      }
    }
    expect(resolveLlamaCppMediaArtifact("hf:unknown/model/mmproj.gguf")).toBeUndefined();
  });

  it("rejects incomplete pairs under total and available memory limits", () => {
    expect(recommendLlamaCppMedia(hardware({ totalMemoryBytes: 4 * GIB }), "cpu")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/total RAM/u),
    });
  });

  it("charges separate volumes separately and shared capacity only once", () => {
    const host = hardware({
      availableDiskBytes: 3 * GIB,
      availableRuntimeDiskBytes: 2 * GIB,
      sharedDisk: false,
    });
    expect(recommendLlamaCppMedia(host, "cpu").kind).toBe("recommended");
    expect(recommendLlamaCppMedia({ ...host, sharedDisk: true }, "cpu").kind).toBe("unavailable");
    expect(
      recommendLlamaCppMedia({ ...host, availableRuntimeDiskBytes: GIB }, "cpu"),
    ).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("runtime directory"),
    });
  });

  it("credits verified models and projectors independently on retry", () => {
    const initial = recommendLlamaCppMedia(hardware(), "cpu");
    assert(initial.kind === "recommended");
    const artifacts = [initial.ocr, initial.vision].flatMap(({ model, projector }) => [
      model,
      projector,
    ]);
    const artifactSha256 = new Set(artifacts.map((artifact) => artifact.expectedSha256));
    const host = hardware({ availableDiskBytes: 1024 ** 2, availableRuntimeDiskBytes: 1024 ** 2 });
    expect(recommendLlamaCppMedia(host, "cpu", { artifactSha256, runtime: true })).toMatchObject({
      kind: "recommended",
      requiredDiskBytes: 0,
    });
    artifactSha256.delete(initial.vision.projector.expectedSha256);
    expect(recommendLlamaCppMedia(host, "cpu", { artifactSha256, runtime: true }).kind).toBe(
      "unavailable",
    );
    expect(
      recommendLlamaCppMedia(hardware(), "cpu", { artifactSha256, runtime: true }),
    ).toMatchObject({
      kind: "recommended",
      requiredDiskBytes: initial.vision.projector.expectedSize,
    });
    expect(recommendLlamaCppMedia(host, "cpu", { artifactSha256 }).kind).toBe("unavailable");
  });

  it("does not guess when runtime free space is unknown", () => {
    expect(
      recommendLlamaCppMedia(hardware({ availableRuntimeDiskBytes: undefined }), "cpu"),
    ).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("permissions"),
    });
  });

  it.each([
    ["metal", 5, "smolvlm2-2.2b-instruct-q4_k_m"],
    ["metal", 4, "smolvlm2-500m-video-instruct-q8_0"],
    ["metal", 3.5, undefined],
    ["cpu", 5, "smolvlm2-2.2b-instruct-q4_k_m"],
    ["cpu", 4, undefined],
  ] as const)(
    "selects a complete %s pair within %s GiB available memory",
    (backend, available, vision) => {
      const result = recommendLlamaCppMedia(
        hardware({
          platform: backend === "metal" ? "darwin" : "linux",
          arch: backend === "metal" ? "arm64" : "x64",
          totalMemoryBytes: 16 * GIB,
          availableMemoryBytes: available * GIB,
          accelerator:
            backend === "metal" ? { kind: "metal" } : { kind: "cpu", reason: "CPU host" },
        }),
        backend,
      );
      if (vision) {
        expect(result).toMatchObject({
          kind: "recommended",
          ocr: { id: "glm-ocr-q8_0" },
          vision: { id: vision },
        });
      } else {
        expect(result).toMatchObject({
          kind: "unavailable",
          reason: expect.stringMatching(/memory|RAM/u),
        });
      }
    },
  );

  it("selects the smaller Metal vision pair when only its downloads fit the shared volume", () => {
    const result = recommendLlamaCppMedia(
      hardware({
        platform: "darwin",
        arch: "arm64",
        accelerator: { kind: "metal" },
        availableDiskBytes: 4 * GIB,
        availableRuntimeDiskBytes: 4 * GIB,
      }),
      "metal",
    );
    expect(result).toMatchObject({
      kind: "recommended",
      ocr: { id: "glm-ocr-q8_0" },
      vision: { id: "smolvlm2-500m-video-instruct-q8_0" },
      requiredDiskBytes: 1_980_430_944 + 2 * GIB,
    });
  });
});
