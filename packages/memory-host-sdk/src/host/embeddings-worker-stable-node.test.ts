// Covers stable Node executable selection for the local embedding worker.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  fork: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    fork: childProcessMocks.fork,
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      access: fsMocks.access,
    },
    access: fsMocks.access,
  };
});

import { createLocalEmbeddingWorkerProvider } from "./embeddings-worker.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockWorkerChild() {
  const child = new EventEmitter() as EventEmitter & {
    connected: boolean;
    killed: boolean;
    disconnect: () => void;
    kill: () => void;
    send: (message: { id: number }, callback?: (err: Error | null) => void) => void;
  };
  child.connected = true;
  child.killed = false;
  child.disconnect = vi.fn(() => {
    child.connected = false;
  });
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  child.send = vi.fn((message: { id: number }, callback?: (err: Error | null) => void) => {
    callback?.(null);
    queueMicrotask(() => child.emit("message", { id: message.id, ok: true }));
  });
  childProcessMocks.fork.mockReturnValue(child);
  return child;
}

describe("local embedding worker stable Node path", () => {
  it("forks Homebrew Cellar parents through the stable opt symlink", async () => {
    const originalExecPath = process.execPath;
    const staleNode = "/opt/homebrew/Cellar/node/26.3.0/bin/node";
    const stableNode = "/opt/homebrew/opt/node/bin/node";
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: staleNode,
    });
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === stableNode) {
        return;
      }
      throw new Error("missing");
    });
    mockWorkerChild();

    try {
      const provider = await createLocalEmbeddingWorkerProvider(
        {
          config: {} as never,
          provider: "local",
          model: "",
          fallback: "none",
        },
        { workerScriptPath: "/tmp/openclaw-local-embedding-worker.cjs" },
      );
      await provider.close?.();
    } finally {
      Object.defineProperty(process, "execPath", {
        configurable: true,
        value: originalExecPath,
      });
    }

    expect(childProcessMocks.fork).toHaveBeenCalledWith(
      "/tmp/openclaw-local-embedding-worker.cjs",
      [],
      expect.objectContaining({ execPath: stableNode }),
    );
  });
});
