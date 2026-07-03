import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => vi.fn());
const accessMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  fork: forkMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: accessMock,
  },
}));

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    connected: boolean;
    killed: boolean;
    send: (message: unknown, callback?: (err: Error | null) => void) => void;
    disconnect: () => void;
    kill: () => void;
  };
  child.connected = true;
  child.killed = false;
  child.disconnect = vi.fn(() => {
    child.connected = false;
  });
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  child.send = vi.fn((message: unknown, callback?: (err: Error | null) => void) => {
    callback?.(null);
    const id = (message as { id?: number }).id;
    queueMicrotask(() => {
      child.emit("message", { id, ok: true });
    });
  });
  return child;
}

async function importWorkerModule() {
  return await import("./embeddings-worker.js");
}

describe("local embedding worker stable execPath", () => {
  const originalExecPath = process.execPath;

  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    accessMock.mockReset();
  });

  afterEach(() => {
    process.execPath = originalExecPath;
  });

  it("passes the Homebrew opt symlink as fork execPath for Cellar Node paths", async () => {
    process.execPath = "/opt/homebrew/Cellar/node/26.3.0/bin/node";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/opt/homebrew/opt/node/bin/node") {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    forkMock.mockReturnValue(createMockChild());
    const { createLocalEmbeddingWorkerProvider } = await importWorkerModule();

    const provider = await createLocalEmbeddingWorkerProvider(
      { config: {} as never, provider: "local", model: "", fallback: "none" },
      { workerScriptPath: "/tmp/embedding-worker.cjs" },
    );

    expect(forkMock).toHaveBeenCalledWith(
      "/tmp/embedding-worker.cjs",
      [],
      expect.objectContaining({ execPath: "/opt/homebrew/opt/node/bin/node" }),
    );
    await provider.close?.();
  });

  it("falls back to the Homebrew bin symlink for the default node formula", async () => {
    process.execPath = "/usr/local/Cellar/node/26.3.0/bin/node";
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === "/usr/local/bin/node") {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    forkMock.mockReturnValue(createMockChild());
    const { createLocalEmbeddingWorkerProvider } = await importWorkerModule();

    const provider = await createLocalEmbeddingWorkerProvider(
      { config: {} as never, provider: "local", model: "", fallback: "none" },
      { workerScriptPath: "/tmp/embedding-worker.cjs" },
    );

    expect(forkMock).toHaveBeenCalledWith(
      "/tmp/embedding-worker.cjs",
      [],
      expect.objectContaining({ execPath: "/usr/local/bin/node" }),
    );
    await provider.close?.();
  });

  it("keeps non-Cellar execPath unchanged", async () => {
    process.execPath = "/usr/bin/node";
    forkMock.mockReturnValue(createMockChild());
    const { createLocalEmbeddingWorkerProvider } = await importWorkerModule();

    const provider = await createLocalEmbeddingWorkerProvider(
      { config: {} as never, provider: "local", model: "", fallback: "none" },
      { workerScriptPath: "/tmp/embedding-worker.cjs" },
    );

    expect(forkMock).toHaveBeenCalledWith(
      "/tmp/embedding-worker.cjs",
      [],
      expect.objectContaining({ execPath: "/usr/bin/node" }),
    );
    expect(accessMock).not.toHaveBeenCalled();
    await provider.close?.();
  });

  it("does not send a request when the signal aborts while reusing the child", async () => {
    process.execPath = "/usr/bin/node";
    const child = createMockChild();
    forkMock.mockReturnValue(child);
    const { createLocalEmbeddingWorkerProvider } = await importWorkerModule();
    const provider = await createLocalEmbeddingWorkerProvider(
      { config: {} as never, provider: "local", model: "", fallback: "none" },
      { workerScriptPath: "/tmp/embedding-worker.cjs" },
    );
    vi.mocked(child.send).mockClear();
    const abortController = new AbortController();

    const embedPromise = provider.embedQuery("cancelled", { signal: abortController.signal });
    abortController.abort(new Error("cancelled before send"));

    await expect(embedPromise).rejects.toThrow("cancelled before send");
    expect(child.send).not.toHaveBeenCalled();
    await provider.close?.();
  });
});
