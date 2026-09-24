import crypto from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { fetchWorkspaceFile } from "./workspace-file-fetch.js";

function fixture(options: { maxBytes?: number; receipt?: Record<string, unknown> } = {}) {
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
            await receiver(bytes);
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
  return {
    close,
    unsubscribe,
    bytes,
    read: () =>
      fetchWorkspaceFile({
        nodeId: "node",
        params: { path: "/remote/output" },
        openDuplex,
        maxBytes: options.maxBytes ?? bytes.length,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      }),
  };
}

describe("workspace binary file.fetch receiver", () => {
  it("returns bytes only after a matching final receipt and closes its channel", async () => {
    const value = fixture();
    expect(await value.read()).toEqual({ data: value.bytes, canonicalPath: "/remote/output" });
    expect(value.close).toHaveBeenCalledOnce();
    expect(value.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects excess bytes before accepting the final receipt", async () => {
    const value = fixture({ maxBytes: 5 });
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
