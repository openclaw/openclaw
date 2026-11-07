import { formatLlamaCppMemory, type LlamaCppHardware } from "./hardware.js";
import { resolveLlamaCppDiskBudget, resolveLlamaCppMemoryBudget } from "./model-catalog.js";

const GIB = 1024 ** 3;

export type LlamaCppMediaArtifact = {
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
const SMOL_VLM2_COMPACT_REPOSITORY = "ggml-org/SmolVLM2-500M-Video-Instruct-GGUF";
const SMOL_VLM2_COMPACT_REVISION = "ccd7aae53bcb1997355c2f094959e72b3642ce17";

// Pinned b10809 supports these GLM4V and Idefics3 projectors; every selected pair
// still needs real inference verification on the Gateway before activation.
// Memory includes both GGUFs, KV/compute buffers and bounded image encoding. The
// router must load one model at a time; these budgets do not permit co-residency.
export const LLAMA_CPP_MEDIA_RECIPES: readonly [
  LlamaCppMediaRecipe,
  LlamaCppMediaRecipe,
  LlamaCppMediaRecipe,
] = [
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
    minimumSystemMemoryBytes: 6 * GIB,
    memoryBytes: 5 * GIB,
    contextSize: 8192,
    maxTokens: 2048,
    imageMaxTokens: 1024,
    limitations: [
      "Small English-focused vision model; complex diagrams and spatial reasoning may be inaccurate.",
    ],
  },
  {
    id: "smolvlm2-500m-video-instruct-q8_0",
    name: "SmolVLM2 500M (Q8_0)",
    capability: "vision",
    model: artifact(
      SMOL_VLM2_COMPACT_REPOSITORY,
      SMOL_VLM2_COMPACT_REVISION,
      "SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
      436_808_704,
      "6f67b8036b2469fcd71728702720c6b51aebd759b78137a8120733b4d66438bc",
    ),
    projector: artifact(
      SMOL_VLM2_COMPACT_REPOSITORY,
      SMOL_VLM2_COMPACT_REVISION,
      "mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
      108_785_184,
      "921dc7e259f308e5b027111fa185efcbf33db13f6e35749ddf7f5cdb60ef520b",
    ),
    minimumSystemMemoryBytes: 6 * GIB,
    memoryBytes: 3 * GIB,
    contextSize: 8192,
    maxTokens: 2048,
    imageMaxTokens: 1024,
    limitations: [
      "Compact English-focused vision model; complex diagrams and spatial reasoning may be inaccurate.",
      "Managed local media accepts one still image per request, including with this video-capable model.",
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

type MediaRecommendation =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "recommended";
      ocr: LlamaCppMediaRecipe;
      vision: LlamaCppMediaRecipe;
      requiredDiskBytes: number;
      reason: string;
    };

export function recommendLlamaCppMedia(
  hardware: LlamaCppHardware,
  backend: "cpu" | "metal",
  // The download owner supplies only artifacts whose size, checksum and format passed.
  cached: { artifactSha256?: ReadonlySet<string>; runtime?: boolean } = {},
): MediaRecommendation {
  const unavailable = (reason: string): MediaRecommendation => ({
    kind: "unavailable",
    reason,
  });
  const memoryBudgetBytes = resolveLlamaCppMemoryBudget(hardware, backend);
  const [ocr, standardVision, compactVision] = LLAMA_CPP_MEDIA_RECIPES;
  // Preserve the released Linux pair. Metal can use the smaller verified recipe
  // when the standard pair exceeds current unified-memory or download capacity.
  const visionCandidates = backend === "metal" ? [standardVision, compactVision] : [standardVision];
  const minimumSystemMemory = Math.max(
    ocr.minimumSystemMemoryBytes,
    Math.min(...visionCandidates.map((recipe) => recipe.minimumSystemMemoryBytes)),
  );
  if (hardware.totalMemoryBytes < minimumSystemMemory) {
    return unavailable(
      `Local OCR and vision require ${formatLlamaCppMemory(minimumSystemMemory)} total RAM; host has ${formatLlamaCppMemory(hardware.totalMemoryBytes)}. Use a host with more memory and retry setup.`,
    );
  }
  const candidates = visionCandidates.filter(
    (recipe) =>
      hardware.totalMemoryBytes >= recipe.minimumSystemMemoryBytes &&
      memoryBudgetBytes >= recipe.memoryBytes,
  );
  if (memoryBudgetBytes < ocr.memoryBytes || candidates.length === 0) {
    const required = Math.max(
      ocr.memoryBytes,
      Math.min(...visionCandidates.map((r) => r.memoryBytes)),
    );
    return unavailable(
      `Local OCR and vision require at least ${formatLlamaCppMemory(required)} memory; the system memory budget is ${formatLlamaCppMemory(memoryBudgetBytes)} after host headroom and current memory pressure. Close other applications or use a host with more memory and retry setup.`,
    );
  }
  const disk = resolveLlamaCppDiskBudget(hardware, backend, cached.runtime);
  if (disk.kind === "unavailable") {
    return unavailable(disk.reason);
  }
  const { modelDiskBudget, runtimeDiskBytes } = disk;
  let requiredModelDiskBytes = Number.POSITIVE_INFINITY;
  for (const vision of candidates) {
    const modelDiskBytes = [ocr.model, ocr.projector, vision.model, vision.projector].reduce(
      (bytes, item) =>
        bytes + (cached.artifactSha256?.has(item.expectedSha256) ? 0 : item.expectedSize),
      0,
    );
    requiredModelDiskBytes = Math.min(requiredModelDiskBytes, modelDiskBytes);
    if (modelDiskBytes <= modelDiskBudget) {
      return {
        kind: "recommended",
        ocr,
        vision,
        requiredDiskBytes: modelDiskBytes + runtimeDiskBytes,
        reason: `${ocr.name} (OCR, ${formatLlamaCppMemory(ocr.memoryBytes)}) and ${vision.name} (vision, ${formatLlamaCppMemory(vision.memoryBytes)}) fit the ${formatLlamaCppMemory(memoryBudgetBytes)} ${backend === "metal" ? "Metal unified memory" : "CPU memory"} budget. Load one model at a time, preserving the chat and embedding inventory. Images stay local; runtime verification must pass before activation.`,
      };
    }
  }
  return unavailable(
    `Missing OCR and vision models and projectors need ${formatLlamaCppMemory(requiredModelDiskBytes)} disk space; ${formatLlamaCppMemory(Math.max(0, modelDiskBudget))} remains after the runtime reserve. Free space in the model cache and retry setup.`,
  );
}
