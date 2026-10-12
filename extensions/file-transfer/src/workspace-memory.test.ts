import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createNodeWorkspaceMemory } from "./workspace-memory.js";

describe("node Memory maintenance requester authority", () => {
  it.each(["writeDreams", "appendCorpus"] as const)(
    "fences %s after duplex preparation and settles accepted cleanup",
    async (method) => {
      for (const revoked of [true, false]) {
        const prepared = createDeferred<void>();
        const release = createDeferred<void>();
        const closing = createDeferred<void>();
        const closed = createDeferred<unknown>();
        let dispatchAuthority: (() => void) | undefined;
        let current = true;
        let receive: ((bytes: Uint8Array) => void | Promise<void>) | undefined;
        const assertCurrent = () => {
          if (!current) {
            throw new Error("requester revoked");
          }
        };
        const send = vi.fn(async () => {
          await receive?.(
            Buffer.from(JSON.stringify({ result: method === "appendCorpus" ? 7 : undefined })),
          );
          closed.resolve({ payload: { ok: true } });
        });
        const openDuplex: NonNullable<OpenClawPluginServiceContext["openNodeDuplex"]> = async (
          request,
        ) => {
          dispatchAuthority = request.assertCurrent;
          prepared.resolve();
          await release.promise;
          return {
            send,
            onMessage: (listener) => {
              receive = listener;
              return () => {
                receive = undefined;
              };
            },
            close: () => closing.resolve(),
            closed: closed.promise,
          };
        };
        const files = createNodeWorkspaceMemory({
          workspaceDir: "/gateway",
          remoteRoot: "/node",
          nodeId: "node-1",
          signal: new AbortController().signal,
          openDuplex,
        });
        let settled = false;
        const operation = files
          .maintenance![method]("/gateway/DREAMS.md", "entry\n", assertCurrent)
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true;
          });
        try {
          await awaitGateBeforeSettlement(prepared.promise, operation, "duplex never prepared");
          current = !revoked;
          release.resolve();
          await awaitGateBeforeSettlement(closing.promise, operation, "channel never closed");
          if (revoked) {
            expect(send).not.toHaveBeenCalled();
            expect(settled).toBe(false);
            closed.reject(new Error("accepted cleanup settled"));
            expect(await operation).toMatchObject({ error: { message: "requester revoked" } });
            expect(dispatchAuthority).toBeTypeOf("function");
            expect(() => dispatchAuthority!()).toThrow("requester revoked");
          } else {
            expect(await operation).toEqual({ result: method === "appendCorpus" ? 7 : undefined });
            expect(send).toHaveBeenCalledExactlyOnceWith(Buffer.from("start"));
          }
        } finally {
          release.resolve();
          closed.resolve({ payload: { ok: true } });
          await operation;
        }
      }
    },
  );
});
