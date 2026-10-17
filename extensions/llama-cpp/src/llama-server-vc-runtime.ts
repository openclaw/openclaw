import { execFile } from "node:child_process";
import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { WindowsVcRuntimeDependency } from "./llama-server-assets.js";

const CAB_HEADER_SIZE = 12;
const EXPAND_TIMEOUT_MS = 60_000;

async function extractPinnedContainer(params: {
  asset: WindowsVcRuntimeDependency;
  bundlePath: string;
  containerPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const source = await fs.open(params.bundlePath, "r");
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size !== params.asset.size) {
      throw new Error(
        `Visual C++ runtime bundle size mismatch: expected ${params.asset.size}, got ${stat.size}`,
      );
    }
    if (
      params.asset.containerOffset < 0 ||
      params.asset.containerSize < CAB_HEADER_SIZE ||
      params.asset.containerOffset + params.asset.containerSize > stat.size
    ) {
      throw new Error("invalid Visual C++ runtime container bounds");
    }
    const header = Buffer.alloc(CAB_HEADER_SIZE);
    const headerRead = await source.read(header, 0, header.length, params.asset.containerOffset);
    if (
      headerRead.bytesRead !== header.length ||
      header.subarray(0, 4).toString("ascii") !== "MSCF" ||
      header.readUInt32LE(8) !== params.asset.containerSize
    ) {
      throw new Error("Visual C++ runtime bundle does not contain the pinned cabinet");
    }

    await pipeline(
      source.createReadStream({
        start: params.asset.containerOffset,
        end: params.asset.containerOffset + params.asset.containerSize - 1,
        autoClose: false,
      }),
      createWriteStream(params.containerPath, { flags: "wx", mode: 0o600 }),
      { signal: params.signal },
    );
  } finally {
    await source.close();
  }
}

function resolveExpandCommand(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot is unavailable; cannot extract the Visual C++ runtime");
  }
  return path.win32.join(systemRoot, "System32", "expand.exe");
}

async function runExpand(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: EXPAND_TIMEOUT_MS, signal, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          reject(
            new Error(`Failed to extract the Visual C++ runtime${detail ? `: ${detail}` : ""}`, {
              cause: error,
            }),
          );
        } else {
          resolve();
        }
      },
    );
  });
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.nlink > 1) {
    throw new Error(`Visual C++ runtime does not contain regular file ${label}`);
  }
}

/** Extracts the pinned Microsoft redistributable DLLs without installing machine-wide state. */
export async function extractWindowsVcRuntime(params: {
  bundlePath: string;
  destDir: string;
  asset: WindowsVcRuntimeDependency;
  signal?: AbortSignal;
}): Promise<string> {
  const { nestedCabinet, files } = params.asset;

  const expandCommand = resolveExpandCommand();
  const containerPath = path.join(params.destDir, "bundle.cab");
  const nestedDir = path.join(params.destDir, "nested");
  const filesDir = path.join(params.destDir, "files");
  await Promise.all([
    fs.mkdir(params.destDir, { recursive: true }),
    fs.mkdir(nestedDir, { recursive: true }),
    fs.mkdir(filesDir, { recursive: true }),
  ]);
  await extractPinnedContainer({
    asset: params.asset,
    bundlePath: params.bundlePath,
    containerPath,
    signal: params.signal,
  });
  await runExpand(expandCommand, [`-F:${nestedCabinet}`, containerPath, nestedDir], params.signal);
  const nestedPath = path.join(nestedDir, nestedCabinet);
  await assertRegularFile(nestedPath, nestedCabinet);

  for (const file of files) {
    params.signal?.throwIfAborted();
    await runExpand(expandCommand, [`-F:${file.source}`, nestedPath, filesDir], params.signal);
    const sourcePath = path.join(filesDir, file.source);
    await assertRegularFile(sourcePath, file.source);
    const targetPath = path.join(params.destDir, file.target);
    await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  }
  return params.destDir;
}
