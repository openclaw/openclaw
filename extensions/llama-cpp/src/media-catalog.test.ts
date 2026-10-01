import { describe, expect, it } from "vitest";
import type { LlamaCppHardware } from "./hardware.js";
import {
  LLAMA_CPP_MEDIA_RECIPES,
  recommendLlamaCppMedia,
  resolveLlamaCppMediaArtifact,
} from "./media-catalog.js";

const GIB = 1024 ** 3;
const OCR = "glm-ocr-q8_0";
const VISION = "smolvlm2-2.2b-instruct-q4_k_m";

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
      expect(recipe.supportedBackends).toEqual(["cpu"]);
      expect(recipe.projector.repository).toBe(recipe.model.repository);
      expect(recipe.projector.revision).toBe(recipe.model.revision);
      for (const artifact of [recipe.model, recipe.projector]) {
        expect(artifact.revision).toMatch(/^[a-f0-9]{40}$/u);
        expect(artifact.expectedSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(artifact.expectedSize).toBeGreaterThan(0);
        expect(artifact.url).toBe(
          `https://huggingface.co/${artifact.repository}/resolve/${artifact.revision}/${artifact.filename}?download=true`,
        );
        expect(resolveLlamaCppMediaArtifact(artifact.source)).toBe(artifact);
        expect(
          resolveLlamaCppMediaArtifact(artifact.source.replace(artifact.revision, "main")),
        ).toBeUndefined();
      }
    }
    expect(resolveLlamaCppMediaArtifact("hf:unknown/model/mmproj.gguf")).toBeUndefined();
  });

  it("selects distinct OCR/vision recipes with on-demand CPU residency", () => {
    const result = recommendLlamaCppMedia(hardware(), "cpu");
    expect(result).toMatchObject({
      kind: "recommended",
      ocr: { id: OCR, prompt: "Text Recognition:" },
      vision: { id: VISION },
      modelsMax: 1,
    });
    expect(recommendLlamaCppMedia(hardware(), "cpu")).toEqual(result);
  });

  it.each([
    { host: hardware({ totalMemoryBytes: 4 * GIB }), reason: /total RAM/u },
    { host: hardware({ availableMemoryBytes: 3 * GIB }), reason: /current memory pressure/u },
    {
      host: hardware({ totalMemoryBytes: 3 * GIB, availableMemoryBytes: 2 * GIB }),
      reason: /total RAM/u,
    },
  ])(
    "rejects incomplete pairs under total, available, and constrained memory limits",
    ({ host, reason }) => {
      expect(recommendLlamaCppMedia(host, "cpu")).toMatchObject({
        kind: "unavailable",
        rejections: expect.arrayContaining([
          {
            id: OCR,
            capability: "ocr",
            reasons: expect.arrayContaining([expect.stringMatching(reason)]),
          },
        ]),
      });
    },
  );

  it.each([
    { host: hardware(), backend: "cuda" as const, reason: /did not detect/u },
    {
      host: hardware({ platform: "freebsd" }),
      backend: "cpu" as const,
      reason: /No verified llama-server/u,
    },
    {
      host: hardware({ arch: "riscv64" }),
      backend: "cpu" as const,
      reason: /No verified llama-server/u,
    },
  ])("explains unavailable platform/backend assets", ({ host, backend, reason }) => {
    expect(recommendLlamaCppMedia(host, backend)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(reason),
    });
  });

  it("rejects a partial setup when the complete verified pair does not fit disk", () => {
    expect(recommendLlamaCppMedia(hardware({ availableDiskBytes: 4 * GIB }), "cpu")).toMatchObject({
      kind: "unavailable",
      rejections: [
        { id: VISION, capability: "vision", reasons: [expect.stringContaining("projectors")] },
      ],
    });
  });

  it("retains memory headroom beyond the measured small vision fixture", () => {
    expect(
      recommendLlamaCppMedia(hardware({ availableMemoryBytes: 4.5 * GIB }), "cpu"),
    ).toMatchObject({
      kind: "unavailable",
      rejections: [
        { id: VISION, capability: "vision", reasons: [expect.stringContaining("Requires 5 GiB")] },
      ],
    });
    expect(recommendLlamaCppMedia(hardware({ totalMemoryBytes: 7.75 * GIB }), "cpu")).toMatchObject(
      {
        kind: "recommended",
        vision: { id: VISION, memoryBytes: 5 * GIB },
      },
    );
  });

  it("charges separate volumes separately and shared capacity only once", () => {
    const host = hardware({
      availableDiskBytes: 3 * GIB,
      availableRuntimeDiskBytes: 2 * GIB,
      sharedDisk: false,
    });
    expect(recommendLlamaCppMedia(host, "cpu")).toMatchObject({
      kind: "recommended",
      runtimeDiskBytes: 2 * GIB,
    });
    expect(recommendLlamaCppMedia({ ...host, sharedDisk: true }, "cpu").kind).toBe("unavailable");
    expect(
      recommendLlamaCppMedia({ ...host, availableRuntimeDiskBytes: GIB }, "cpu"),
    ).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("runtime volume"),
    });
  });

  it("credits verified models and projectors independently on retry", () => {
    const initial = recommendLlamaCppMedia(hardware(), "cpu");
    if (initial.kind !== "recommended") {
      throw new Error(initial.reason);
    }
    const artifacts = [
      initial.ocr.model,
      initial.ocr.projector,
      initial.vision.model,
      initial.vision.projector,
    ];
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
      modelDiskBytes: initial.vision.projector.expectedSize,
    });
    expect(recommendLlamaCppMedia(host, "cpu", { artifactSha256 }).kind).toBe("unavailable");
  });

  it.each([undefined, 0])("fails closed when model disk space is %s", (availableDiskBytes) => {
    expect(recommendLlamaCppMedia(hardware({ availableDiskBytes }), "cpu").kind).toBe(
      "unavailable",
    );
  });

  it("does not guess when runtime free space is unknown", () => {
    expect(
      recommendLlamaCppMedia(hardware({ availableRuntimeDiskBytes: undefined }), "cpu"),
    ).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("permissions"),
    });
  });
});
