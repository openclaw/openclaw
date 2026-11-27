import path from "node:path";
import type { ArchiveExtractLimits } from "openclaw/plugin-sdk/archive";
import { resolveLlamaCppDataDir } from "./defaults.js";

// The binary build named by the upstream v1.1.0 stable release.
export const LLAMA_SERVER_RELEASE = "b12774";
export const LLAMA_SERVER_BUILD = 12_774;
export const LLAMA_SERVER_COMMIT = "171527522610996f5f0acf12334e185156ca8f44";

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
  maxExtractedBytes: 650 * MEBIBYTE,
  maxEntryBytes: 580 * MEBIBYTE,
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
  ["libggml-rpc.1.1.1.dylib", ["libggml-rpc.1.dylib", "libggml-rpc.dylib"]],
  ["libllama.1.1.0.dylib", ["libllama.1.dylib", "libllama.dylib"]],
  ["libmtmd.1.1.0.dylib", ["libmtmd.1.dylib", "libmtmd.dylib"]],
  ["libggml.1.1.1.dylib", ["libggml.1.dylib", "libggml.dylib"]],
  ["libggml-base.1.1.1.dylib", ["libggml-base.1.dylib", "libggml-base.dylib"]],
  ["libggml-blas.1.1.1.dylib", ["libggml-blas.1.dylib", "libggml-blas.dylib"]],
  ["libllama-common.1.1.0.dylib", ["libllama-common.1.dylib", "libllama-common.dylib"]],
  ["libggml-cpu.1.1.1.dylib", ["libggml-cpu.1.dylib", "libggml-cpu.dylib"]],
] as const satisfies RegularFileAliases;

const MACOS_METAL_ALIASES = [
  ...MACOS_ALIASES,
  ["libggml-metal.1.1.1.dylib", ["libggml-metal.1.dylib", "libggml-metal.dylib"]],
] as const satisfies RegularFileAliases;

const LINUX_ALIASES = [
  ["libllama.so.1.1.0", ["libllama.so.1", "libllama.so"]],
  ["libggml.so.1.1.1", ["libggml.so.1", "libggml.so"]],
  ["libmtmd.so.1.1.0", ["libmtmd.so.1", "libmtmd.so"]],
  ["libggml-base.so.1.1.1", ["libggml-base.so.1", "libggml-base.so"]],
  ["libllama-common.so.1.1.0", ["libllama-common.so.1", "libllama-common.so"]],
] as const satisfies RegularFileAliases;

const LLAMA_SERVER_ASSETS: LlamaServerAsset[] = [
  {
    platform: "darwin",
    arch: "arm64",
    backend: "metal",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: "70311c4751ed3221e63f47769327dd088d7400f76dcfb81c66ec843db165814d",
    sizeBytes: 16_889_601,
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
    sha256: "0368e3dbdae70065a928c130aa235efc84090bb7817c3267998f00df4e6ed862",
    sizeBytes: 12_619_002,
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
    sha256: "068e15b27cfaf2733855c313baad26fbce84952cbb770500e806073c41aa4214",
    sizeBytes: 19_014_279,
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
    sha256: "ab5837cca2317cfb7ecb5f85b550934e7355cd9df74cdde6e106581457034dbb",
    sizeBytes: 23_454_685,
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
    sha256: "7c2f8e99f7ffe244e5cba92e6c2b65f1d04fbabe8d4eb304d3fa200778ccf8f3",
    sizeBytes: 357_985_904,
    executable: "llama-server.exe",
    regularFileAliases: [],
    // b12774 expands to 797 MiB, including a 733 MiB ggml-cuda.dll.
    limits: {
      ...CUDA_ARCHIVE_LIMITS,
      maxExtractedBytes: 800 * MEBIBYTE,
      maxEntryBytes: 735 * MEBIBYTE,
    },
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
    sha256: "0ba8524390eee562ce196a5a901ea26cc4af1ea539b932fef0e91f4a5f7c8b3c",
    sizeBytes: 13_357_105,
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
    sha256: "44b70b20f3374eec3d16a002beceefef33cc3565678caeb3eea5f6cacba61836",
    sizeBytes: 25_288_075,
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
