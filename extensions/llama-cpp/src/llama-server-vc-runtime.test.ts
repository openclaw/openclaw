import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLAMA_SERVER_BUILD,
  LLAMA_SERVER_COMMIT,
  selectLlamaServerAsset,
  type LlamaServerDependency,
} from "./llama-server-assets.js";
import { ensureLlamaServerInstalled } from "./llama-server-install.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  resolveLlamaCppDataDir: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./defaults.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./defaults.js")>()),
  resolveLlamaCppDataDir: mocks.resolveLlamaCppDataDir,
}));

const tempRoots: string[] = [];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.execFile.mockReset();
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.resolveLlamaCppDataDir.mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(process.cwd(), ".llama-vc-runtime-test-")),
  );
  tempRoots.push(root);
  const dataDir = path.join(root, "data");
  mocks.resolveLlamaCppDataDir.mockReturnValue(dataDir);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const containerOffset = 32;
  const containerSize = 48;
  const bundle = Buffer.alloc(96, 0x5a);
  bundle.write("MSCF", containerOffset, "ascii");
  bundle.writeUInt32LE(containerSize, containerOffset + 8);
  const runtime: Extract<LlamaServerDependency, { archive: "vc-redist" }> = {
    archive: "vc-redist",
    name: "runtime.exe",
    url: "https://example.invalid/runtime.exe",
    sha256: digest(bundle),
    size: bundle.length,
    containerOffset,
    containerSize,
    nestedCabinet: "a4",
    files: [
      { source: "msvcp140.dll_amd64", target: "msvcp140.dll" },
      { source: "vcruntime140.dll_amd64", target: "vcruntime140.dll" },
    ],
  };
  const source = selectLlamaServerAsset("win32", "x64", { kind: "cpu" });
  const serverBytes = await new JSZip()
    .file(source.executable, "server")
    .generateAsync({ type: "nodebuffer" });
  const carved: Buffer[] = [];
  let launches = 0;
  mocks.execFile.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: unknown, stdout: string, stderr: string) => void,
    ) => {
      if (!command.endsWith("\\expand.exe")) {
        launches += 1;
        callback(
          launches === 1 ? new Error("runtime missing") : null,
          "version: test (build " +
            LLAMA_SERVER_BUILD +
            ", commit " +
            LLAMA_SERVER_COMMIT.slice(0, 9) +
            ")",
          "",
        );
        return;
      }
      void (async () => {
        const filter = args[0]?.slice(3);
        const input = args[1];
        const destination = args[2];
        if (!filter || !input || !destination) {
          throw new Error("Expected a named CAB extraction");
        }
        if (filter === runtime.nestedCabinet) {
          carved.push(await fs.readFile(input));
        }
        await fs.writeFile(path.join(destination, filter), "extracted:" + filter);
      })().then(
        () => callback(null, "", ""),
        (error: unknown) => callback(error, "", ""),
      );
    },
  );
  mocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => ({
    response: new Response(new Uint8Array(url === runtime.url ? bundle : serverBytes)),
    release: vi.fn(),
  }));
  const install = (signal?: AbortSignal) =>
    ensureLlamaServerInstalled({
      asset: {
        ...source,
        sha256: digest(serverBytes),
        dependencies: [{ ...runtime, sha256: digest(bundle) }],
      },
      signal,
    });
  return { install, runtime, bundle, carved, containerOffset, containerSize, dataDir };
}

describe("managed installer Visual C++ fallback", () => {
  it("carves the pinned CAB and extracts only the named app-local DLLs", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const { command } = await fixture.install(controller.signal);

    expect(fixture.carved).toEqual([
      fixture.bundle.subarray(
        fixture.containerOffset,
        fixture.containerOffset + fixture.containerSize,
      ),
    ]);
    const expansions = mocks.execFile.mock.calls.filter(([file]) => file.endsWith("\\expand.exe"));
    expect(expansions).toHaveLength(3);
    expect(expansions[0]).toEqual([
      "C:\\Windows\\System32\\expand.exe",
      [
        "-F:a4",
        expect.stringMatching(/[\\/]bundle\.cab$/u),
        expect.stringMatching(/[\\/]nested$/u),
      ],
      expect.objectContaining({ timeout: 60_000, windowsHide: true, signal: controller.signal }),
      expect.any(Function),
    ]);
    expect(expansions.map(([, args]) => args[0])).toEqual([
      "-F:a4",
      "-F:msvcp140.dll_amd64",
      "-F:vcruntime140.dll_amd64",
    ]);
    for (const file of fixture.runtime.files) {
      await expect(
        fs.readFile(path.join(path.dirname(command), file.target), "utf8"),
      ).resolves.toBe("extracted:" + file.source);
    }
  });

  it("rejects a bundle whose pinned range is not the expected CAB", async () => {
    const fixture = await createFixture();
    fixture.bundle.write("NOPE", fixture.containerOffset, "ascii");

    await expect(fixture.install()).rejects.toThrow("does not contain the pinned cabinet");
    expect(mocks.execFile.mock.calls.filter(([file]) => file.endsWith("\\expand.exe"))).toEqual([]);
    expect(await fs.readdir(fixture.dataDir)).toEqual([]);
  });
});
