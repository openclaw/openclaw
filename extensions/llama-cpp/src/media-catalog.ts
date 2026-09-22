import { formatLlamaCppMemory, type LlamaCppHardware } from "./hardware.js";
import {
  LLAMA_SERVER_BUILD,
  selectLlamaServerAsset,
  type LlamaServerAsset,
} from "./llama-server-assets.js";
import { resolveLlamaCppModelCandidates } from "./model-catalog.js";

const GIB = 1024 ** 3;
type MediaBackend = LlamaServerAsset["backend"];

export type LlamaCppMediaArtifact = {
  repository: string;
  revision: string;
  filename: string;
  source: string;
  fileName: string;
  url: string;
  expectedSize: number;
  expectedSha256: string;
};

export type LlamaCppMediaRecipe = {
  id: string;
  name: string;
  capability: "ocr" | "vision";
  model: LlamaCppMediaArtifact;
  projector: LlamaCppMediaArtifact;
  supportedBackends: readonly MediaBackend[];
  supportedRuntimeBuild: number;
  minimumSystemMemoryBytes: number;
  memoryBytes: number;
  contextSize: number;
  maxTokens: number;
  imageMaxTokens: number;
  limitations: readonly string[];
  prompt?: string;
};

function artifact(
  repository: string,
  revision: string,
  filename: string,
  expectedSize: number,
  expectedSha256: string,
): LlamaCppMediaArtifact {
  return {
    repository,
    revision,
    filename,
    source: `hf:${repository}/${filename}#${revision}`,
    fileName: `hf_${repository.replaceAll("/", "_")}_${revision}_${filename}`,
    url: `https://huggingface.co/${repository}/resolve/${revision}/${filename}?download=true`,
    expectedSize,
    expectedSha256,
  };
}

const GLM_OCR_REPOSITORY = "ggml-org/GLM-OCR-GGUF";
const GLM_OCR_REVISION = "65a42de1148dbed2297e922b5dbc7d9b70c36578";
const SMOL_VLM2_REPOSITORY = "ggml-org/SmolVLM2-2.2B-Instruct-GGUF";
const SMOL_VLM2_REVISION = "1bc3c9f74ceafd4c8d4411cc9cf188bba3798f91";

// Pinned b10809 supports these GLM4V and Idefics3 projectors; every selected pair
// still needs real inference verification on the Gateway before activation.
// Memory includes both GGUFs, KV/compute buffers and bounded image encoding. The
// router must load one model at a time; these budgets do not permit co-residency.
export const LLAMA_CPP_MEDIA_RECIPES: readonly LlamaCppMediaRecipe[] = [
  {
    id: "glm-ocr-q8_0",
    name: "GLM-OCR (Q8_0)",
    capability: "ocr",
    model: artifact(
      GLM_OCR_REPOSITORY,
      GLM_OCR_REVISION,
      "GLM-OCR-Q8_0.gguf",
      950_433_408,
      "45bc244a6446aff850521dc41f18bc8d7105ad5f0c2c8c28af04e7cc4f4d50b1",
    ),
    projector: artifact(
      GLM_OCR_REPOSITORY,
      GLM_OCR_REVISION,
      "mmproj-GLM-OCR-Q8_0.gguf",
      484_403_648,
      "9c4b58e33e316ed142eb5dcb41abec3844d3e6e5dc361ffb782c3fa9d175141f",
    ),
    supportedBackends: ["cpu"],
    supportedRuntimeBuild: 10_809,
    minimumSystemMemoryBytes: 6 * GIB,
    memoryBytes: 4 * GIB,
    contextSize: 8192,
    maxTokens: 4096,
    imageMaxTokens: 1024,
    prompt: "Text Recognition:",
    limitations: [
      "Recognizes text; use the vision model for scenes, charts, and spatial questions.",
      "Dense or multi-column pages may need separate crops; no document layout detector is installed.",
      "Image encoding is limited to 1024 tokens (about 0.8 megapixels); small text may lose detail.",
    ],
  },
  {
    id: "smolvlm2-2.2b-instruct-q4_k_m",
    name: "SmolVLM2 2.2B (Q4_K_M)",
    capability: "vision",
    model: artifact(
      SMOL_VLM2_REPOSITORY,
      SMOL_VLM2_REVISION,
      "SmolVLM2-2.2B-Instruct-Q4_K_M.gguf",
      1_112_602_656,
      "0cf76814555b8665149075b74ab6b5c1d428ea1d3d01c1918c12012e8d7c9f58",
    ),
    projector: artifact(
      SMOL_VLM2_REPOSITORY,
      SMOL_VLM2_REVISION,
      "mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf",
      592_523_200,
      "ae07ea1facd07dd3230c4483b63e8cda96c6944ad2481f33d531f79e892dd024",
    ),
    supportedBackends: ["cpu"],
    supportedRuntimeBuild: 10_809,
    minimumSystemMemoryBytes: 6 * GIB,
    memoryBytes: 5 * GIB,
    contextSize: 8192,
    maxTokens: 2048,
    imageMaxTokens: 1024,
    limitations: [
      "Small English-focused vision model; complex diagrams and spatial reasoning may be inaccurate.",
    ],
  },
];

export function resolveLlamaCppMediaArtifact(source: string): LlamaCppMediaArtifact | undefined {
  for (const recipe of LLAMA_CPP_MEDIA_RECIPES) {
    for (const value of [recipe.model, recipe.projector]) {
      if (value.source === source) {
        return value;
      }
    }
  }
  return undefined;
}

type MediaRejection = {
  id: string;
  capability: LlamaCppMediaRecipe["capability"];
  reasons: string[];
};

type MediaRecommendation =
  | { kind: "unavailable"; reason: string; rejections: MediaRejection[] }
  | {
      kind: "recommended";
      ocr: LlamaCppMediaRecipe;
      vision: LlamaCppMediaRecipe;
      asset: LlamaServerAsset;
      memoryBudgetBytes: number;
      modelDiskBytes: number;
      runtimeDiskBytes: number;
      requiredDiskBytes: number;
      modelsMax: 1;
      reason: string;
      rejections: MediaRejection[];
    };

export function recommendLlamaCppMedia(
  hardware: LlamaCppHardware,
  backend: MediaBackend,
  // The download owner supplies only artifacts whose size, checksum and format passed.
  cached: { artifactSha256?: ReadonlySet<string>; runtime?: boolean } = {},
): MediaRecommendation {
  const rejections: MediaRejection[] = [];
  const unavailable = (reason: string): MediaRecommendation => ({
    kind: "unavailable",
    reason,
    rejections,
  });
  if (backend !== "cpu" && hardware.accelerator.kind !== backend) {
    return unavailable(
      `The Gateway did not detect a usable ${backend} backend. Choose CPU setup or check the accelerator.`,
    );
  }
  let asset: LlamaServerAsset;
  try {
    asset = selectLlamaServerAsset(
      hardware.platform,
      hardware.arch,
      backend === "cuda" ? hardware.accelerator : { kind: backend },
    );
  } catch (error) {
    return unavailable(
      error instanceof Error
        ? error.message
        : "No verified llama.cpp runtime is available for this host.",
    );
  }
  const memoryBudgetBytes = Math.max(
    0,
    resolveLlamaCppModelCandidates(hardware, backend).memoryBudgetBytes,
  );
  const candidates = LLAMA_CPP_MEDIA_RECIPES.filter((recipe) => {
    const reasons: string[] = [];
    if (!recipe.supportedBackends.includes(backend)) {
      reasons.push(`Does not support the ${backend} backend.`);
    }
    if (recipe.supportedRuntimeBuild !== LLAMA_SERVER_BUILD) {
      reasons.push(
        `Requires verified llama.cpp build ${recipe.supportedRuntimeBuild}; available build is ${LLAMA_SERVER_BUILD}.`,
      );
    }
    if (hardware.totalMemoryBytes < recipe.minimumSystemMemoryBytes) {
      reasons.push(
        `Requires ${formatLlamaCppMemory(recipe.minimumSystemMemoryBytes)} total RAM; host has ${formatLlamaCppMemory(hardware.totalMemoryBytes)}.`,
      );
    }
    if (memoryBudgetBytes < recipe.memoryBytes) {
      reasons.push(
        `Requires ${formatLlamaCppMemory(recipe.memoryBytes)} memory; the ${backend === "cuda" ? "single GPU and system" : backend === "metal" ? "unified" : "system"} memory budget is ${formatLlamaCppMemory(memoryBudgetBytes)} after host headroom and current memory pressure.`,
      );
    }
    if (reasons.length > 0) {
      rejections.push({ id: recipe.id, capability: recipe.capability, reasons });
    }
    return reasons.length === 0;
  });
  if (
    !candidates.some((recipe) => recipe.capability === "ocr") ||
    !candidates.some((recipe) => recipe.capability === "vision")
  ) {
    return unavailable(
      "No complete OCR and vision pair fits this Gateway. Close other applications or use a host with more memory; see candidate rejections.",
    );
  }
  if (
    hardware.availableDiskBytes === undefined ||
    hardware.availableRuntimeDiskBytes === undefined
  ) {
    return unavailable(
      "Cannot measure free space in the model cache or runtime directory. Check their permissions and retry setup.",
    );
  }
  // Reuse the managed install reserve: archive, extraction and interrupted work.
  const runtimeDiskBytes = cached.runtime ? 0 : (backend === "cuda" ? 3 : 2) * GIB;
  if (!hardware.sharedDisk && hardware.availableRuntimeDiskBytes < runtimeDiskBytes) {
    return unavailable(
      `The runtime volume needs ${formatLlamaCppMemory(runtimeDiskBytes)} free; only ${formatLlamaCppMemory(hardware.availableRuntimeDiskBytes)} is available.`,
    );
  }
  const modelDiskBudget = hardware.sharedDisk
    ? Math.min(hardware.availableDiskBytes, hardware.availableRuntimeDiskBytes) - runtimeDiskBytes
    : hardware.availableDiskBytes;
  for (const ocr of candidates.filter((recipe) => recipe.capability === "ocr")) {
    for (const vision of candidates.filter((recipe) => recipe.capability === "vision")) {
      const artifacts = new Map(
        [ocr.model, ocr.projector, vision.model, vision.projector].map((value) => [
          value.expectedSha256,
          value,
        ]),
      );
      const modelDiskBytes = [...artifacts.values()].reduce(
        (bytes, value) =>
          bytes + (cached.artifactSha256?.has(value.expectedSha256) ? 0 : value.expectedSize),
        0,
      );
      if (modelDiskBytes > modelDiskBudget) {
        rejections.push({
          id: vision.id,
          capability: vision.capability,
          reasons: [
            `Together with ${ocr.name}, missing models and projectors need ${formatLlamaCppMemory(modelDiskBytes)} disk space; ${formatLlamaCppMemory(Math.max(0, modelDiskBudget))} remains after the runtime reserve.`,
          ],
        });
        continue;
      }
      return {
        kind: "recommended",
        ocr,
        vision,
        asset,
        memoryBudgetBytes,
        modelDiskBytes,
        runtimeDiskBytes,
        requiredDiskBytes: modelDiskBytes + runtimeDiskBytes,
        modelsMax: 1,
        reason: `${ocr.name} (OCR, ${formatLlamaCppMemory(ocr.memoryBytes)}) and ${vision.name} (vision, ${formatLlamaCppMemory(vision.memoryBytes)}) fit the ${formatLlamaCppMemory(memoryBudgetBytes)} ${backend === "metal" ? "Metal unified memory" : backend === "cuda" ? "single NVIDIA GPU and system memory" : "CPU memory"} budget. Load one model at a time, preserving the chat and embedding inventory. Images stay local; runtime verification must pass before activation.`,
        rejections,
      };
    }
  }
  return unavailable(
    "There is not enough disk space for a complete OCR and vision pair and the managed runtime. Free space in the model cache and retry setup.",
  );
}
