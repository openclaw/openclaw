import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function mockDownload(body: BodyInit, release = vi.fn(async () => {})) {
  const response = new Response(body);
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response,
    finalUrl: "https://huggingface.co/fixture",
    release,
  });
  return { response, release };
}

describe("ONNX artifact installation", () => {
  it("publishes only complete hash-verified files and reuses valid existing artifacts", async () => {
    const root = tempDirs.make("models-");
    const target = path.join(root, model.id, "model.onnx");
    const { release } = mockDownload(
      bytes,
      vi.fn(async () => {
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      }),
    );
    await downloadModel(root, model, new AbortController().signal);
    await verifyModel(root, model);
    expect(await readModelArtifact(root, model, file)).toEqual(bytes);
    expect(await fs.readFile(target)).toEqual(bytes);
    expect(await fs.readdir(path.join(root, model.id))).toEqual(["model.onnx"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600 & ~process.umask());
    }
    expect(release).toHaveBeenCalledOnce();
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await downloadModel(root, model, new AbortController().signal);
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "downloads through an operator's directory alias",
    async () => {
      const root = tempDirs.make("model-directory-alias-");
      const destination = path.join(root, "operator-models");
      await fs.mkdir(destination);
      await fs.symlink(destination, path.join(root, model.id));
      mockDownload(bytes);
      await downloadModel(root, model, new AbortController().signal);
      await verifyModel(root, model);
      expect(await fs.readFile(path.join(destination, "model.onnx"))).toEqual(bytes);
      expect(await fs.readdir(destination)).toEqual(["model.onnx"]);
      expect((await fs.lstat(path.join(root, model.id))).isSymbolicLink()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves group-writable model cache directories",
    async () => {
      const root = tempDirs.make("shared-model-cache-");
      const destination = path.join(root, model.id);
      await fs.mkdir(destination);
      await fs.chmod(root, 0o775);
      await fs.chmod(destination, 0o775);
      mockDownload(bytes);
      await downloadModel(root, model, new AbortController().signal);
      await verifyModel(root, model);
      expect((await fs.stat(root)).mode & 0o777).toBe(0o775);
      expect((await fs.stat(destination)).mode & 0o777).toBe(0o775);
      expect(await fs.readdir(destination)).toEqual(["model.onnx"]);
    },
  );

  it.each([
    { name: "short download", body: Buffer.from("invalid"), error: /integrity/ },
    { name: "wrong hash", body: Buffer.alloc(bytes.length), error: /integrity/ },
    { name: "oversized download", body: Buffer.alloc(bytes.length + 1), error: /pinned size/ },
  ])("removes partial files and releases a $name", async ({ body, error }) => {
    const root = tempDirs.make("bad-model-");
    const { response, release } = mockDownload(body);
    await expect(downloadModel(root, model, new AbortController().signal)).rejects.toThrow(error);
    expect(await fs.readdir(path.join(root, model.id))).toEqual([]);
    expect(response.body?.locked).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("cancels the response and removes staged bytes when a pending read is aborted", async () => {
    const root = tempDirs.make("aborted-model-");
    const controller = new AbortController();
    const reason = new Error("cancel model download");
    const cancel = vi.fn();
    const { response, release } = mockDownload(
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
    await expect(downloadModel(root, model, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(path.join(root, model.id))).toEqual([]);
    expect(response.body?.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not publish when releasing the download fails", async () => {
    const root = tempDirs.make("unreleased-model-");
    const failure = new Error("download release failed");
    const { release } = mockDownload(
      bytes,
      vi.fn(async () => {
        throw failure;
      }),
    );
    await expect(downloadModel(root, model, new AbortController().signal)).rejects.toBe(failure);
    expect(await fs.readdir(path.join(root, model.id))).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "verified", winner: bytes, accepted: true },
    { name: "mismatched", winner: Buffer.from("keep this"), accepted: false },
  ])("preserves a $name artifact published by a competing writer", async ({ winner, accepted }) => {
    const root = tempDirs.make("raced-model-");
    const target = path.join(root, model.id, "model.onnx");
    const { release } = mockDownload(
      bytes,
      vi.fn(async () => {
        await fs.writeFile(target, winner, { flag: "wx" });
      }),
    );
    const download = downloadModel(root, model, new AbortController().signal);
    if (accepted) {
      await download;
    } else {
      await expect(download).rejects.toThrow("model-integrity");
    }
    expect(await fs.readFile(target)).toEqual(winner);
    expect(await fs.readdir(path.join(root, model.id))).toEqual(["model.onnx"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
    "reuses an operator's verified %s without downloading",
    async (kind) => {
      const root = tempDirs.make("linked-model-");
      const external = path.join(root, "operator-model.onnx");
      const destination = path.join(root, model.id);
      const target = path.join(destination, "model.onnx");
      await fs.mkdir(destination);
      await fs.writeFile(external, bytes);
      await (kind === "symlink" ? fs.symlink(external, target) : fs.link(external, target));
      vi.mocked(fetchWithSsrFGuard).mockClear();
      await downloadModel(root, model, new AbortController().signal);
      expect(await fs.readFile(target)).toEqual(bytes);
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(kind === "symlink");
      expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    },
  );

  it("refuses to overwrite an existing mismatched operator file", async () => {
    const root = tempDirs.make("existing-");
    await fs.mkdir(path.join(root, model.id));
    await fs.writeFile(path.join(root, model.id, "model.onnx"), "keep this");
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await expect(downloadModel(root, model, new AbortController().signal)).rejects.toThrow(
      "model-integrity",
    );
    expect(await fs.readFile(path.join(root, model.id, "model.onnx"), "utf8")).toBe("keep this");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", data: undefined, code: "model-missing" },
    { name: "empty", data: Buffer.alloc(0), code: "model-integrity" },
    { name: "wrong hash", data: Buffer.alloc(bytes.length), code: "model-integrity" },
    { name: "oversized", data: Buffer.alloc(bytes.length + 1), code: "model-integrity" },
  ])("reports a $name installed artifact", async ({ data, code }) => {
    const root = tempDirs.make("verify-model-");
    await fs.mkdir(path.join(root, model.id));
    if (data !== undefined) {
      await fs.writeFile(path.join(root, model.id, file.name), data);
    }
    await expect(verifyModel(root, model)).rejects.toThrow(code);
  });

  it.each(["grows", "shrinks"])("rejects an artifact that %s after admission", async (change) => {
    const root = tempDirs.make("changing-model-");
    const target = path.join(root, model.id, file.name);
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, bytes);
    const handle = await fs.open(target, "r");
    const stat = handle.stat.bind(handle);
    const statSpy = vi.spyOn(handle, "stat").mockImplementationOnce(async (...args) => {
      const before = await stat(...args);
      if (change === "grows") {
        await fs.appendFile(target, "unexpected trailing bytes");
      } else {
        await fs.truncate(target, bytes.length - 1);
      }
      return before;
    });
    const openSpy = vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    try {
      await expect(verifyModel(root, model)).rejects.toThrow("model-integrity");
    } finally {
      openSpy.mockRestore();
      statSpy.mockRestore();
      await handle.close();
    }
  });

  it.each(["read", "verify"])("reports descriptor close failure during %s", async (operation) => {
    const root = tempDirs.make("close-model-");
    const target = path.join(root, model.id, file.name);
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, bytes);
    const handle = await fs.open(target, "r");
    const close = handle.close.bind(handle);
    const failure = new Error("model descriptor close failed");
    const closeSpy = vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      throw failure;
    });
    const openSpy = vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    try {
      await expect(
        operation === "read" ? readModelArtifact(root, model, file) : verifyModel(root, model),
      ).rejects.toBe(failure);
    } finally {
      openSpy.mockRestore();
      closeSpy.mockRestore();
      await close();
    }
  });

  it("rejects local-export path traversal and mismatched source identity", async () => {
    const root = tempDirs.make("local-");
    const local: ModelPreset = {
      ...model,
      source: { kind: "local-export", repository: "example/model", revision: "a".repeat(40) },
    };
    await fs.mkdir(path.join(root, model.id));
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
      await fs.writeFile(
        path.join(root, model.id, "model.json"),
        JSON.stringify({ ...manifest, ...invalid }),
      );
      await expect(resolveModelFiles(root, local)).rejects.toThrow("model-integrity");
    }
    await fs.writeFile(path.join(root, model.id, "model.json"), JSON.stringify(manifest));
    await expect(resolveModelFiles(root, local)).resolves.toEqual([
      { name: "model.onnx", bytes: 1, sha256: "a".repeat(64) },
      { name: "tokenizer.json", bytes: 1, sha256: "b".repeat(64) },
    ]);
  });
});
