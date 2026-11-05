import path from "node:path";
import type { ArchiveExtractLimits } from "openclaw/plugin-sdk/archive";
import { resolveLlamaCppDataDir } from "./defaults.js";

export const LLAMA_SERVER_RELEASE = "b11977";
export const LLAMA_SERVER_BUILD = 11_977;
export const LLAMA_SERVER_COMMIT = "7ac5727d6037ec99c31a28c6520f45de154199d9";

type RegularFileAliases = ReadonlyArray<readonly [source: string, aliases: readonly string[]]>;

export type LlamaServerArchive = {
  archive: "tar.gz" | "zip";
  archiveRoot: string;
  name: string;
  sha256: string;
  sizeBytes?: number;
  url?: string;
  regularFileAliases: RegularFileAliases;
  limits?: ArchiveExtractLimits;
};

export type LlamaServerAsset = LlamaServerArchive & {
  platform: NodeJS.Platform;
  arch: string;
  backend: "metal" | "cpu" | "cuda";
  executable: string;
  dependencies?: readonly LlamaServerDependency[];
};

type WindowsVcRuntimeDependency = {
  archive: "vc-redist";
  containerOffset: number;
  containerSize: number;
  files: ReadonlyArray<{ source: string; target: string }>;
  name: string;
  nestedCabinet: string;
  sha256: string;
  size: number;
  url: string;
};

export type LlamaServerDependency =
  | (LlamaServerArchive & { files: readonly string[] })
  | WindowsVcRuntimeDependency;

const MEBIBYTE = 1024 * 1024;
const CUDA_ARCHIVE_LIMITS = {
  maxArchiveBytes: 400 * MEBIBYTE,
  maxExtractedBytes: 640 * MEBIBYTE,
  maxEntryBytes: 567 * MEBIBYTE,
};

// llama.cpp's Windows release binaries dynamically link the Visual C++ runtime.
// Keep the current supported runtime app-local because managed llama-server runs
// outside any MSIX package graph, including Store-installed OpenClaw. The pinned
// Burn container metadata selects only the imported runtime DLLs from Microsoft's
// signed 14.51.36247 redistributable bundles.
const WINDOWS_X64_VC_RUNTIME = {
  archive: "vc-redist",
  name: "VC_redist.x64.exe",
  url: "https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe",
  sha256: "843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c",
  size: 18_731_856,
  containerOffset: 630_000,
  containerSize: 18_091_661,
  nestedCabinet: "a4",
  files: [
    { source: "msvcp140.dll_amd64", target: "msvcp140.dll" },
    { source: "vcruntime140.dll_amd64", target: "vcruntime140.dll" },
    { source: "vcruntime140_1.dll_amd64", target: "vcruntime140_1.dll" },
  ],
} as const satisfies WindowsVcRuntimeDependency;

const WINDOWS_ARM64_VC_RUNTIME = {
  archive: "vc-redist",
  name: "VC_redist.arm64.exe",
  url: "https://download.visualstudio.microsoft.com/download/pr/ece44298-3977-4f73-ab91-c13fe79cfea8/B70EF586669A620A0A30A1156969C05C6A3831DC8F8BC992DA75779D2A92F944/VC_redist.arm64.exe",
  sha256: "b70ef586669a620a0a30a1156969c05c6a3831dc8f8bc992da75779d2a92f944",
  size: 11_870_816,
  containerOffset: 684_112,
  containerSize: 11_176_508,
  nestedCabinet: "a1",
  files: [
    { source: "msvcp140.dll_arm64", target: "msvcp140.dll" },
    { source: "vcruntime140.dll_arm64", target: "vcruntime140.dll" },
  ],
} as const satisfies WindowsVcRuntimeDependency;

// These basenames are authenticated by the adjacent release checksum. Archive-provided
// links are ignored; update this manifest together with each pinned llama.cpp release.
const MACOS_ALIASES = [
  ["libggml-rpc.0.28.0.dylib", ["libggml-rpc.0.dylib", "libggml-rpc.dylib"]],
  ["libllama.0.8.0.dylib", ["libllama.0.dylib", "libllama.dylib"]],
  ["libmtmd.0.8.0.dylib", ["libmtmd.0.dylib", "libmtmd.dylib"]],
  ["libggml.0.28.0.dylib", ["libggml.0.dylib", "libggml.dylib"]],
  ["libggml-base.0.28.0.dylib", ["libggml-base.0.dylib", "libggml-base.dylib"]],
  ["libggml-blas.0.28.0.dylib", ["libggml-blas.0.dylib", "libggml-blas.dylib"]],
  ["libllama-common.0.8.0.dylib", ["libllama-common.0.dylib", "libllama-common.dylib"]],
  ["libggml-cpu.0.28.0.dylib", ["libggml-cpu.0.dylib", "libggml-cpu.dylib"]],
] as const satisfies RegularFileAliases;

const MACOS_METAL_ALIASES = [
  ...MACOS_ALIASES,
  ["libggml-metal.0.28.0.dylib", ["libggml-metal.0.dylib", "libggml-metal.dylib"]],
] as const satisfies RegularFileAliases;

const LINUX_ALIASES = [
  ["libllama.so.0.8.0", ["libllama.so.0", "libllama.so"]],
  ["libggml.so.0.28.0", ["libggml.so.0", "libggml.so"]],
  ["libmtmd.so.0.8.0", ["libmtmd.so.0", "libmtmd.so"]],
  ["libggml-base.so.0.28.0", ["libggml-base.so.0", "libggml-base.so"]],
  ["libllama-common.so.0.8.0", ["libllama-common.so.0", "libllama-common.so"]],
] as const satisfies RegularFileAliases;

const LLAMA_SERVER_ASSETS: LlamaServerAsset[] = [
  {
    platform: "darwin",
    arch: "arm64",
    backend: "metal",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: "80aec269ac12a1db9665a99e5754a4365c65d4432631b916d15a85f55d735a74",
    sizeBytes: 16_463_726,
    executable: "llama-server",
    regularFileAliases: MACOS_METAL_ALIASES,
  },
  {
    platform: "darwin",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: "51477b2d73146330d0e357107a031e2281d8e1b4e538298cab2f1eba8e0fc43b",
    sizeBytes: 12_207_960,
    executable: "llama-server",
    regularFileAliases: MACOS_ALIASES,
  },
  {
    platform: "linux",
    arch: "arm64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-arm64.tar.gz`,
    sha256: "33f5a93520a0de74714de01d7cf311cddc6354009f75af912ee6cf9b77eb3496",
    sizeBytes: 18_428_812,
    executable: "llama-server",
    regularFileAliases: LINUX_ALIASES,
  },
  {
    platform: "linux",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-x64.tar.gz`,
    sha256: "3b0c3d7d7f7c492f59bb5625bd077727f5322fff72b964dfa32ceca45bbe5053",
    sizeBytes: 22_692_056,
    executable: "llama-server",
    regularFileAliases: LINUX_ALIASES,
  },
  {
    platform: "win32",
    arch: "x64",
    backend: "cuda",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cuda-12.4-x64.zip`,
    sha256: "01d4a7b300f9acf3ef9d81854f426aa12d88b157de1ea1f453d11210c5fe6d57",
    sizeBytes: 279_764_883,
    executable: "llama-server.exe",
    regularFileAliases: [],
    limits: CUDA_ARCHIVE_LIMITS,
    dependencies: [
      {
        archive: "zip",
        archiveRoot: ".",
        name: "cudart-llama-bin-win-cuda-12.4-x64.zip",
        sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
        sizeBytes: 391_443_627,
        regularFileAliases: [],
        files: ["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"],
        limits: { ...CUDA_ARCHIVE_LIMITS, maxEntries: 3 },
      },
      WINDOWS_X64_VC_RUNTIME,
    ],
  },
  {
    platform: "win32",
    arch: "arm64",
    backend: "cpu",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-arm64.zip`,
    sha256: "efa3d02abab4952a6afe63ea273aa1771233dc62ceef766f23312c9165c17dde",
    sizeBytes: 13_021_179,
    executable: "llama-server.exe",
    regularFileAliases: [],
    dependencies: [WINDOWS_ARM64_VC_RUNTIME],
  },
  {
    platform: "win32",
    arch: "x64",
    backend: "cpu",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-x64.zip`,
    sha256: "2438535001da11f38a050b31fea91765f637aef0efa46f465d9af849473f4d05",
    sizeBytes: 24_408_628,
    executable: "llama-server.exe",
    regularFileAliases: [],
    dependencies: [WINDOWS_X64_VC_RUNTIME],
  },
];

export function selectLlamaServerAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  acceleration?:
    | { kind: "cpu" | "metal" }
    | { kind: "cuda"; devices: readonly { driverVersion: string; computeCapability?: number }[] },
): LlamaServerAsset {
  const backend =
    acceleration?.kind ?? (platform === "darwin" && arch === "arm64" ? "metal" : "cpu");
  if (backend === "cuda" && acceleration?.kind === "cuda") {
    if (platform !== "win32" || arch !== "x64") {
      throw new Error(
        `No verified CUDA llama-server ${LLAMA_SERVER_RELEASE} build is available for ${platform}/${arch}. Install a CUDA-enabled llama-server manually and configure its absolute path, or explicitly choose CPU setup.`,
      );
    }
    // The upstream build uses CUDA 12.4 Update 1 with PTX. Require its full driver
    // level: CUDA minor-version compatibility does not guarantee PTX JIT support.
    const compatible =
      acceleration.devices.length > 0 &&
      acceleration.devices.every((device) => {
        const version = /^(\d+)\.(\d+)(?:\.\d+)?$/u.exec(device.driverVersion);
        const driver =
          version &&
          (Number(version[1]) > 551 || (Number(version[1]) === 551 && Number(version[2]) >= 78));
        return driver && (device.computeCapability === undefined || device.computeCapability >= 5);
      });
    if (!compatible) {
      throw new Error(
        "The verified CUDA 12.4 build requires NVIDIA driver 551.78 or newer and compute capability 5.0 or newer. Update the NVIDIA driver, configure a compatible llama-server manually, or explicitly choose CPU setup.",
      );
    }
  }
  const asset = LLAMA_SERVER_ASSETS.find(
    (candidate) =>
      candidate.platform === platform && candidate.arch === arch && candidate.backend === backend,
  );
  if (!asset) {
    throw new Error(
      `No verified llama-server ${LLAMA_SERVER_RELEASE} build is available for ${platform}/${arch}. Install a compatible llama-server manually, then rerun llama.cpp setup with its absolute path.`,
    );
  }
  return asset;
}

export function resolveManagedLlamaServerPaths(asset = selectLlamaServerAsset()): {
  installDir: string;
  command: string;
  presetPath: string;
} {
  const installDir = path.join(
    resolveLlamaCppDataDir(),
    LLAMA_SERVER_RELEASE,
    `${asset.platform}-${asset.arch}${asset.backend === "cuda" ? "-cuda-12.4" : ""}`,
  );
  return {
    installDir,
    command: path.join(installDir, asset.executable),
    presetPath: path.join(resolveLlamaCppDataDir(), "models.ini"),
  };
}

export function findManagedLlamaServerAsset(
  command: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): LlamaServerAsset | undefined {
  // Recover only this host's pinned installation, including its selected backend.
  return LLAMA_SERVER_ASSETS.find(
    (asset) =>
      asset.platform === platform &&
      asset.arch === arch &&
      resolveManagedLlamaServerPaths(asset).command === command,
  );
}
