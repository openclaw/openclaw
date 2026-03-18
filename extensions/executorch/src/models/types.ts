import type { RunnerBackend } from "../native-addon.js";

export type SetupFileGroup = {
  label: string;
  candidates: readonly string[];
};

export type ExecuTorchModelPlugin = {
  /** Stable internal id used in config (e.g. "parakeet"). */
  id: string;
  /** Human-readable model label for logs/CLI text. */
  displayName: string;
  /** Model id reported to OpenClaw media-understanding surfaces. */
  modelId: string;
  /** Backends currently supported by this model plugin. */
  supportedBackends: readonly RunnerBackend[];
  /** Model root folder name under ~/.openclaw/models. */
  modelRootDirName: string;
  /** Default model directory inside modelRootDirName. */
  defaultModelDirName: string;
  defaultModelFileName: string;
  defaultTokenizerFileName: string;
  /** Runtime library file name for the current host platform. */
  runtimeLibraryFileNameForPlatform: (platform: NodeJS.Platform) => string;
  /** Hugging Face repo used by `openclaw executorch setup`. */
  setupRepository: string;
  /** Required model artifacts for setup. */
  setupModelFileGroups: readonly SetupFileGroup[];
  /** Optional runtime file name candidates for setup. */
  setupRuntimeLibraryCandidates: readonly string[];
  /** Fallback names to probe if explicit file path is missing. */
  modelFileCandidates: readonly string[];
  /** Fallback names to probe if explicit file path is missing. */
  tokenizerFileCandidates: readonly string[];
};
