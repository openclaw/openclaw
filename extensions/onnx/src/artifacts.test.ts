import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  source: { kind: "hub", repository: "example/model", revision: "a".repeat(40), files: [file] },
};

function mockDownload(body: BodyInit, onRelease = async () => {}) {
  const response = new Response(body);
  const release = vi.fn(onRelease);
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({ response, finalUrl: "https://hf.co", release });
  return { response, release };
}

let root: string;
let destination: string;
let target: string;
const download = (signal = new AbortController().signal) => downloadModel(root, model, signal);
const verify = () => verifyModel(root, model);
async function install(data: string | Buffer = bytes, location = target) {
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(location, data);
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

it.each(process.platform === "win32" ? [false] : [false, true])(
  "publishes verified artifacts before reuse (directory alias: %s)",
  async (alias) => {
    const aliasTarget = path.join(root, "operator-models");
    if (alias) {
      await fs.mkdir(aliasTarget);
      await fs.symlink(aliasTarget, destination);
    }
    const { release } = mockDownload(bytes, async () =>
      expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" }),
    );
    await download();
    await verify();
    expect(await readModelArtifact(root, model, file)).toEqual(bytes);
    expect(await fs.readdir(destination)).toEqual(["model.onnx"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600 & ~process.umask());
    }
    expect(release).toHaveBeenCalledOnce();
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(alias);
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await download();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "short download", body: Buffer.from("invalid"), error: /integrity/ },
  { name: "wrong hash", body: Buffer.alloc(bytes.length), error: /integrity/ },
  { name: "oversized download", body: Buffer.alloc(bytes.length + 1), error: /pinned size/ },
  { name: "release failure", body: bytes, error: new Error("download release failed") },
])("removes partial files and releases a $name", async ({ body, error }) => {
  const release = error instanceof Error ? () => Promise.reject(error) : undefined;
  const guarded = mockDownload(body, release);
  const operation = expect(download()).rejects;
  await (error instanceof Error ? operation.toBe(error) : operation.toThrow(error));
  await expectUnpublished(guarded);
});

it("cancels the response and removes staged bytes when a pending read is aborted", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel model download");
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        stream.enqueue(bytes);
        controller.abort(reason);
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const guarded = mockDownload(body);
  await expect(download(controller.signal)).rejects.toBe(reason);
  await expectUnpublished(guarded);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([
  { name: "verified", winner: bytes, accepted: true },
  { name: "mismatched", winner: Buffer.alloc(bytes.length), accepted: false },
])("preserves a $name artifact published by a competing writer", async ({ winner, accepted }) => {
  const { release } = mockDownload(bytes, () => fs.writeFile(target, winner, { flag: "wx" }));
  const operation = download();
  await (accepted ? operation : expect(operation).rejects.toThrow("model-integrity"));
  expect(await fs.readFile(target)).toEqual(winner);
  expect(await fs.readdir(destination)).toEqual(["model.onnx"]);
  expect(release).toHaveBeenCalledOnce();
});

it.each(process.platform === "win32" ? ["file"] : ["file", "symlink", "hardlink"])(
  "preserves operator %s without downloading",
  async (kind) => {
    const data = kind === "file" ? Buffer.from("keep this") : bytes;
    const external = path.join(root, "operator-model.onnx");
    await install(data, external);
    const link = kind === "file" ? fs.copyFile : kind === "symlink" ? fs.symlink : fs.link;
    await link(external, target);
    vi.mocked(fetchWithSsrFGuard).mockClear();
    const operation = download();
    await (kind === "file" ? expect(operation).rejects.toThrow("model-integrity") : operation);
    expect(await fs.readFile(target)).toEqual(data);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(kind === "symlink");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  },
);

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

it.each(["grows", "shrinks", "close fails"])("rejects when the artifact %s", async (change) => {
  await install();
  const handle = await fs.open(target, "r");
  const close = handle.close.bind(handle);
  const failure = new Error("model descriptor close failed");
  const openSpy = vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  if (change === "close fails") {
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      throw failure;
    });
  } else {
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementationOnce(async (...args) => {
      const before = await stat(...args);
      await fs.truncate(target, bytes.length + (change === "grows" ? 1 : -1));
      return before;
    });
  }
  try {
    const rejected = expect(verify()).rejects;
    await (change === "close fails" ? rejected.toBe(failure) : rejected.toThrow("model-integrity"));
  } finally {
    openSpy.mockRestore();
    await close();
  }
});

it("rejects local-export path traversal and mismatched source identity", async () => {
  const local: ModelPreset = { ...model, source: { ...model.source, kind: "local-export" } };
  const manifestPath = path.join(destination, "model.json");
  const exportedFiles = [
    { name: "model.onnx", bytes: 1, sha256: "a".repeat(64) },
    { name: "tokenizer.json", bytes: 1, sha256: "b".repeat(64) },
  ];
  const files = exportedFiles.map(({ bytes: size, ...metadata }) => ({ ...metadata, size }));
  const manifest = { modelId: model.id, sourceRevision: "a".repeat(40), files };
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
  await expect(resolveModelFiles(root, local)).resolves.toEqual(exportedFiles);
});
