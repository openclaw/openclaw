import path from "node:path";
import { resolveLlamaCppDataDir } from "./defaults.js";

export const LLAMA_SERVER_RELEASE = "b10534";
export const LLAMA_SERVER_BUILD = 10_534;
export const LLAMA_SERVER_COMMIT = "2b5621094ef383cdcd8428ef6d22efe5df976532";

export type LlamaServerAsset = {
  platform: NodeJS.Platform;
  arch: string;
  backend: "metal" | "cpu";
  archive: "tar.gz" | "zip";
  name: string;
  sha256: string;
  executable: string;
  dependencies?: readonly WindowsVcRuntimeDependency[];
};

export type WindowsVcRuntimeDependency = {
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

const LLAMA_SERVER_ASSETS: LlamaServerAsset[] = [
  {
    platform: "darwin",
    arch: "arm64",
    backend: "metal",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: "51f193eef26b053554e288fb924b24d41d3d7b2bafa338c19e2817fa793d5e86",
    executable: "llama-server",
  },
  {
    platform: "darwin",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: "69b13035f4301354922a8cfacd1bcf2bb2de4ff0c2e19fedb44963378ff53dc5",
    executable: "llama-server",
  },
  {
    platform: "linux",
    arch: "arm64",
    backend: "cpu",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-arm64.tar.gz`,
    sha256: "66535de5cb9293c075a1951c51a3b2ae6f1899623e21177845f6d2a73b78c94e",
    executable: "llama-server",
  },
  {
    platform: "linux",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-x64.tar.gz`,
    sha256: "cc6a12b026edcf1b211be2bb7366c5dadcad778fd8f13019d0694038053d5e4a",
    executable: "llama-server",
  },
  {
    platform: "win32",
    arch: "arm64",
    backend: "cpu",
    archive: "zip",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-arm64.zip`,
    sha256: "d33618b10fda35d34d85da60926c6c470f98f3f66ce6b52c3c1f583461416012",
    executable: "llama-server.exe",
    dependencies: [WINDOWS_ARM64_VC_RUNTIME],
  },
  {
    platform: "win32",
    arch: "x64",
    backend: "cpu",
    archive: "zip",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-x64.zip`,
    sha256: "295ae03ad58d9276afa36f5f8d111d67fc1491c7aff3a3e6d13051a772f93c21",
    executable: "llama-server.exe",
    dependencies: [WINDOWS_X64_VC_RUNTIME],
  },
];

export function selectLlamaServerAsset(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): LlamaServerAsset {
  const asset = LLAMA_SERVER_ASSETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
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
    `${asset.platform}-${asset.arch}`,
  );
  return {
    installDir,
    command: path.join(installDir, asset.executable),
    presetPath: path.join(resolveLlamaCppDataDir(), "models.ini"),
  };
}
