import crypto from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { FILE_FETCH_CHUNK_BYTES } from "./shared/file-fetch-protocol.js";
import { createNodeWorkspaceBridge } from "./workspace-bridge.js";

function fixture(
  options: {
    boundedReplies?: boolean;
    excess?: boolean;
    receipt?: Record<string, unknown>;
  } = {},
) {
  const bytes = Buffer.from("output");
  const closed = createDeferred<unknown>();
  let receiver: ((message: Uint8Array) => void | Promise<void>) | undefined;
  const close = vi.fn();
  const unsubscribe = vi.fn();
  const openDuplex = vi.fn<NonNullable<OpenClawPluginServiceContext["openNodeDuplex"]>>(
    async () => ({
      send: async (message) => {
        if (Buffer.from(message).toString() !== "start") {
          return;
        }
        // Match native delivery: send completes before asynchronous receiver completion.
        void Promise.resolve()
          .then(async () => {
            if (!receiver) {
              throw new Error("receiver was not registered before START");
            }
            if (options.excess) {
              const chunk = Buffer.alloc(FILE_FETCH_CHUNK_BYTES);
              for (let index = 0; index < 17; index += 1) {
                await receiver(chunk);
              }
            } else {
              await receiver(bytes);
            }
            closed.resolve({
              payload: {
                ok: true,
                transport: "binary",
                path: "/remote/output",
                size: bytes.length,
                sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
                ...options.receipt,
              },
            });
          })
          .catch(closed.reject);
      },
      onMessage: (listener) => {
        receiver = listener;
        return unsubscribe;
      },
      closed: closed.promise,
      close,
    }),
  );
  const invoke = vi.fn<OpenClawPluginApi["runtime"]["nodes"]["invoke"]>(async () => ({
    payload: { ok: false, code: "FILE_TOO_LARGE" },
  }));
  const bridge = createNodeWorkspaceBridge({
    nodeId: "node",
    workspaceDir: "/workspace",
    remoteRoot: "/remote",
    invoke,
    openDuplex,
    signal: new AbortController().signal,
    boundedReplies: options.boundedReplies,
  });
  return {
    bytes,
    close,
    invoke,
    openDuplex,
    unsubscribe,
    read: (maxBytes = 16 * 1024 * 1024 + 1, signal?: AbortSignal) =>
      bridge.readFile({
        filePath: "/workspace/output",
        maxBytes,
        signal,
      }),
  };
}

describe("node workspace binary reads", () => {
  it("selects one policy-checked duplex invocation at the default workspace budget", async () => {
    const selected = fixture({ boundedReplies: true });
    const maxBytes = 16 * 1024 * 1024;
    await expect(selected.read(maxBytes)).resolves.toEqual(selected.bytes);
    expect(selected.invoke).not.toHaveBeenCalled();
    expect(selected.openDuplex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: "file.fetch",
        params: expect.objectContaining({ maxBytes, transport: "binary" }),
        timeoutMs: 60_000,
      }),
    );
  });

  it.each([
    ["NOT_FOUND", "ENOENT"],
    ["FILE_TOO_LARGE", "FILE_TOO_LARGE"],
    ["SYMLINK_REDIRECT", "SYMLINK_REDIRECT"],
  ])("preserves a structured %s refusal before duplex readiness", async (code, localCode) => {
    const selected = fixture({ boundedReplies: true });
    selected.openDuplex.mockRejectedValueOnce(
      Object.assign(new Error("file preflight refused"), {
        details: { fileTransferError: { ok: false, code } },
      }),
    );
    await expect(selected.read()).rejects.toMatchObject({ code: localCode });
    expect(selected.openDuplex).toHaveBeenCalledOnce();
    expect(selected.invoke).not.toHaveBeenCalled();
  });

  it("does not translate the caller's cancellation into a missing file", async () => {
    const selected = fixture({ boundedReplies: true });
    const abort = new AbortController();
    const reason = Object.assign(new Error("caller cancelled"), {
      details: { fileTransferError: { ok: false, code: "NOT_FOUND" } },
    });
    selected.openDuplex.mockImplementationOnce(async () => {
      abort.abort(reason);
      throw reason;
    });
    await expect(selected.read(16 * 1024 * 1024, abort.signal)).rejects.toBe(reason);
    expect(selected.invoke).not.toHaveBeenCalled();
  });

  it("rejects a digest-valid receipt outside the selected workspace", async () => {
    const selected = fixture({ boundedReplies: true, receipt: { path: "/outside/output" } });
    await expect(selected.read(16 * 1024 * 1024)).rejects.toThrow(
      "outside the configured node workspace",
    );
    expect(selected.close).toHaveBeenCalledOnce();
  });

  it("rejects excess bytes before accepting the final receipt", async () => {
    const value = fixture({ excess: true });
    await expect(value.read()).rejects.toThrow("oversized");
    expect(value.close).toHaveBeenCalledOnce();
    expect(value.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([{ size: 5 }, { sha256: "0".repeat(64) }, { transport: undefined }])(
    "rejects an inconsistent final receipt %j",
    async (receipt) => {
      const value = fixture({ receipt });
      await expect(value.read()).rejects.toThrow("receipt does not match");
      expect(value.close).toHaveBeenCalledOnce();
      expect(value.unsubscribe).toHaveBeenCalledOnce();
    },
  );
});
