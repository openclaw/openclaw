import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowsVcRuntimeDependency } from "./llama-server-assets.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

import { extractWindowsVcRuntime } from "./llama-server-vc-runtime.js";

const tempRoots: string[] = [];
const originalSystemRoot = process.env.SystemRoot;

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.execFile.mockReset();
  if (originalSystemRoot === undefined) {
    delete process.env.SystemRoot;
  } else {
    process.env.SystemRoot = originalSystemRoot;
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".llama-vc-runtime-test-"));
  tempRoots.push(root);
  const containerOffset = 32;
  const containerSize = 48;
  const bundle = Buffer.alloc(96, 0x5a);
  bundle.write("MSCF", containerOffset, "ascii");
  bundle.writeUInt32LE(containerSize, containerOffset + 8);
  const bundlePath = path.join(root, "runtime.exe");
  const destDir = path.join(root, "extracted");
  await fs.writeFile(bundlePath, bundle);
  const asset: WindowsVcRuntimeDependency = {
    archive: "vc-redist",
    name: "runtime.exe",
    url: "https://example.invalid/runtime.exe",
    sha256: "0".repeat(64),
    size: bundle.length,
    containerOffset,
    containerSize,
    nestedCabinet: "a4",
    files: [
      { source: "msvcp140.dll_amd64", target: "msvcp140.dll" },
      { source: "vcruntime140.dll_amd64", target: "vcruntime140.dll" },
    ],
  };
  return { asset, bundle, bundlePath, containerOffset, containerSize, destDir };
}

describe("extractWindowsVcRuntime", () => {
  it("carves the pinned CAB and extracts only the named app-local DLLs", async () => {
    const fixture = await createFixture();
    process.env.SystemRoot = "C:\\Windows";
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const filter = args[0]?.slice(3);
        const destination = args[2]!;
        void (async () => {
          if (filter === fixture.asset.nestedCabinet) {
            const carved = await fs.readFile(args[1]!);
            expect(carved).toEqual(
              fixture.bundle.subarray(
                fixture.containerOffset,
                fixture.containerOffset + fixture.containerSize,
              ),
            );
          }
          await fs.writeFile(path.join(destination, filter!), `extracted:${filter}`);
        })().then(
          () => callback(null, "", ""),
          (error: unknown) => callback(error as Error, "", ""),
        );
      },
    );

    await expect(
      extractWindowsVcRuntime({
        asset: fixture.asset,
        bundlePath: fixture.bundlePath,
        destDir: fixture.destDir,
      }),
    ).resolves.toBe(fixture.destDir);

    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    expect(mocks.execFile).toHaveBeenNthCalledWith(
      1,
      "C:\\Windows\\System32\\expand.exe",
      ["-F:a4", path.join(fixture.destDir, "bundle.cab"), path.join(fixture.destDir, "nested")],
      expect.objectContaining({ timeout: 60_000, windowsHide: true }),
      expect.any(Function),
    );
    for (const file of fixture.asset.files) {
      await expect(fs.readFile(path.join(fixture.destDir, file.target), "utf8")).resolves.toBe(
        `extracted:${file.source}`,
      );
    }
  });

  it("rejects a bundle whose pinned range is not the expected CAB", async () => {
    const fixture = await createFixture();
    process.env.SystemRoot = "C:\\Windows";
    const bundle = await fs.readFile(fixture.bundlePath);
    bundle.write("NOPE", fixture.containerOffset, "ascii");
    await fs.writeFile(fixture.bundlePath, bundle);

    await expect(
      extractWindowsVcRuntime({
        asset: fixture.asset,
        bundlePath: fixture.bundlePath,
        destDir: fixture.destDir,
      }),
    ).rejects.toThrow("does not contain the pinned cabinet");
    expect(execFile).not.toHaveBeenCalled();
  });
});
