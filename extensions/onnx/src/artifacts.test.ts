import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadModel, readModelArtifact, resolveModelFiles, verifyModel } from "./artifacts.js";
import type { ModelPreset } from "./catalog.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = Buffer.from("synthetic model artifact");
const file = {
  name: "model.onnx",
  path: "model.onnx",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const model: ModelPreset = {
  id: "fixture",
  name: "Fixture",
  family: "gliclass",
  maxTokens: 512,
  source: {
    kind: "hub",
    repository: "example/model",
    revision: "a".repeat(40),
    files: [file],
  },
};

function mockDownload(body: BodyInit, onRelease = async () => {}) {
  const response = new Response(body);
  const release = vi.fn(onRelease);
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response,
    finalUrl: "https://huggingface.co/fixture",
    release,
  });
  return { response, release };
}

describe("ONNX artifact installation", () => {
  let root: string;
  let destination: string;
  let target: string;
  const download = (signal = new AbortController().signal) => downloadModel(root, model, signal);
  const verify = () => verifyModel(root, model);
  async function install(data: string | Buffer = bytes, location = target) {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(location, data);
  }
  async function withHandle(run: (handle: FileHandle) => Promise<void>) {
    await install();
    const handle = await fs.open(target, "r");
    const openSpy = vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    try {
      await run(handle);
    } finally {
      openSpy.mockRestore();
      await handle.close();
    }
  }
  async function expectUnpublished({ response, release }: ReturnType<typeof mockDownload>) {
    expect(await fs.readdir(destination)).toEqual([]);
    expect(response.body?.locked).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  }
  beforeEach(() => {
    root = tempDirs.make("models-");
    destination = path.join(root, model.id);
    target = path.join(destination, file.name);
  });

  it("publishes only complete hash-verified files and reuses valid existing artifacts", async () => {
    const { release } = mockDownload(bytes, async () =>
      expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" }),
    );
    await download();
    await verify();
    expect(await readModelArtifact(root, model, file)).toEqual(bytes);
    expect(await fs.readFile(target)).toEqual(bytes);
    expect(await fs.readdir(destination)).toEqual(["model.onnx"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600 & ~process.umask());
    }
    expect(release).toHaveBeenCalledOnce();
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await download();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "downloads through an operator's directory alias",
    async () => {
      const aliasTarget = path.join(root, "operator-models");
      await fs.mkdir(aliasTarget);
      await fs.symlink(aliasTarget, destination);
      mockDownload(bytes);
      await download();
      await verify();
      expect(await fs.readFile(path.join(aliasTarget, file.name))).toEqual(bytes);
      expect(await fs.readdir(aliasTarget)).toEqual(["model.onnx"]);
      expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
    },
  );

  it.each([
    { name: "short download", body: Buffer.from("invalid"), error: /integrity/ },
    { name: "wrong hash", body: Buffer.alloc(bytes.length), error: /integrity/ },
    { name: "oversized download", body: Buffer.alloc(bytes.length + 1), error: /pinned size/ },
  ])("removes partial files and releases a $name", async ({ body, error }) => {
    const guarded = mockDownload(body);
    await expect(download()).rejects.toThrow(error);
    await expectUnpublished(guarded);
  });

  it("cancels the response and removes staged bytes when a pending read is aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel model download");
    const cancel = vi.fn();
    const guarded = mockDownload(
      new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            stream.enqueue(bytes);
            controller.abort(reason);
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    await expect(download(controller.signal)).rejects.toBe(reason);
    await expectUnpublished(guarded);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not publish when releasing the download fails", async () => {
    const failure = new Error("download release failed");
    const guarded = mockDownload(bytes, async () => {
      throw failure;
    });
    await expect(download()).rejects.toBe(failure);
    expect(await fs.readdir(destination)).toEqual([]);
    expect(guarded.release).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "verified", winner: bytes, accepted: true },
    { name: "mismatched", winner: Buffer.alloc(bytes.length), accepted: false },
  ])("preserves a $name artifact published by a competing writer", async ({ winner, accepted }) => {
    const { release } = mockDownload(bytes, () => fs.writeFile(target, winner, { flag: "wx" }));
    const operation = download();
    if (accepted) {
      await operation;
    } else {
      await expect(operation).rejects.toThrow("model-integrity");
    }
    expect(await fs.readFile(target)).toEqual(winner);
    expect(await fs.readdir(destination)).toEqual(["model.onnx"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
    "reuses an operator's verified %s without downloading",
    async (kind) => {
      const external = path.join(root, "operator-model.onnx");
      await install(bytes, external);
      await (kind === "symlink" ? fs.symlink(external, target) : fs.link(external, target));
      vi.mocked(fetchWithSsrFGuard).mockClear();
      await download();
      expect(await fs.readFile(target)).toEqual(bytes);
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(kind === "symlink");
      expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    },
  );

  it("refuses to overwrite an existing mismatched operator file", async () => {
    await install("keep this");
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await expect(download()).rejects.toThrow("model-integrity");
    expect(await fs.readFile(target, "utf8")).toBe("keep this");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", data: undefined, code: "model-missing" },
    { name: "empty", data: Buffer.alloc(0), code: "model-integrity" },
    { name: "oversized", data: Buffer.alloc(bytes.length + 1), code: "model-integrity" },
  ])("reports a $name installed artifact", async ({ data, code }) => {
    if (data !== undefined) {
      await install(data);
    }
    await expect(verify()).rejects.toThrow(code);
  });

  it.each(["grows", "shrinks"])("rejects an artifact that %s after admission", async (change) => {
    await withHandle(async (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async (...args) => {
        const before = await stat(...args);
        if (change === "grows") {
          await fs.appendFile(target, "unexpected trailing bytes");
        } else {
          await fs.truncate(target, bytes.length - 1);
        }
        return before;
      });
      await expect(verify()).rejects.toThrow("model-integrity");
    });
  });

  it("reports descriptor close failure during verification", async () => {
    await withHandle(async (handle) => {
      const close = handle.close.bind(handle);
      const failure = new Error("model descriptor close failed");
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        throw failure;
      });
      await expect(verify()).rejects.toBe(failure);
    });
  });

  it("rejects local-export path traversal and mismatched source identity", async () => {
    const local: ModelPreset = {
      ...model,
      source: { kind: "local-export", repository: "example/model", revision: "a".repeat(40) },
    };
    const manifestPath = path.join(destination, "model.json");
    const manifest = {
      modelId: model.id,
      sourceRevision: "a".repeat(40),
      files: [
        { name: "model.onnx", size: 1, sha256: "a".repeat(64) },
        { name: "tokenizer.json", size: 1, sha256: "b".repeat(64) },
      ],
    };
    for (const invalid of [
      { files: [...manifest.files, { name: "../other", size: 1, sha256: "a".repeat(64) }] },
      { files: [] },
      { modelId: "different" },
      { sourceRevision: "b".repeat(40) },
    ]) {
      await install(JSON.stringify({ ...manifest, ...invalid }), manifestPath);
      await expect(resolveModelFiles(root, local)).rejects.toThrow("model-integrity");
    }
    await install(JSON.stringify(manifest), manifestPath);
    await expect(resolveModelFiles(root, local)).resolves.toEqual([
      { name: "model.onnx", bytes: 1, sha256: "a".repeat(64) },
      { name: "tokenizer.json", bytes: 1, sha256: "b".repeat(64) },
    ]);
  });
});
