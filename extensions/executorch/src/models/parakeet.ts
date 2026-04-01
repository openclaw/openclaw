import type { ExecuTorchModelPlugin } from "./types.js";

function defaultParakeetRuntimeLibraryFileName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "libparakeet_tdt_runtime.dylib";
  if (platform === "win32") return "parakeet_tdt_runtime.dll";
  return "libparakeet_tdt_runtime.so";
}

export const PARAKEET_MODEL_PLUGIN: ExecuTorchModelPlugin = {
  id: "parakeet",
  displayName: "Parakeet-TDT",
  modelId: "parakeet-tdt-0.6b-v3",
  supportedBackends: ["metal"],
  modelRootDirName: "parakeet",
  defaultModelDirName: "parakeet-tdt-metal",
  defaultModelFileName: "model.pte",
  defaultTokenizerFileName: "tokenizer.model",
  runtimeLibraryFileNameForPlatform: defaultParakeetRuntimeLibraryFileName,
  setupRepository: "younghan-meta/Parakeet-TDT-ExecuTorch-Metal",
  setupModelFileGroups: [
    { label: "model", candidates: ["model.pte"] },
    { label: "tokenizer", candidates: ["tokenizer.model"] },
  ],
  setupRuntimeLibraryCandidates: [
    "libparakeet_tdt_runtime.dylib",
    "parakeet_tdt_runtime.dll",
    "libparakeet_tdt_runtime.so",
  ],
  modelFileCandidates: ["model.pte", "parakeet.pte"],
  tokenizerFileCandidates: ["tokenizer.model", "tokenizer.json"],
};
