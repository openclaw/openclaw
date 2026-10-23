import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import type * as Plugin from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { handleFileCreate } from "./node-host/file-create.js";
import { handleFileFetch } from "./node-host/file-fetch.js";
import { handleWorkspaceCommand as runWorkspace } from "./node-host/workspace-memory.js";
import { createFileTransferNodeInvokePolicy } from "./shared/node-invoke-policy.js";
import { createCtx } from "./shared/node-invoke-policy.test-support.js";
import { handleWorkspaceWorkerPolicy } from "./shared/workspace-memory-policy.js";

const workerKinds = new Map<string, "memory" | "skills">([
  ["workspace.memory", "memory"],
  ["workspace.skills", "skills"],
]);

/** Real policy and file handlers; only the paired connection is replaced here. */
export function createNodeWorkspaceTestTransport(
  api: Plugin.OpenClawPluginApi,
  remote: string,
  afterChunk?: () => void,
  onOutput?: (bytes: Uint8Array) => void,
): NonNullable<Plugin.OpenClawPluginServiceContext["openNodeDuplex"]> {
  return async (request) => {
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;
    const ready = createDeferred<void>();
    let receive: ((message: Uint8Array) => void | Promise<void>) | undefined;
    let acknowledge: ((message: Uint8Array) => void | Promise<void>) | undefined;
    const io: OpenClawPluginNodeHostCommandIo = {
      signal,
      emitChunk: async () => {},
      onInput: () => {},
      frames: {
        onMessage: (listener) => {
          receive = listener;
          ready.resolve();
          return () => {
            receive = undefined;
          };
        },
        send: async (message) => {
          onOutput?.(message);
          await acknowledge?.(message);
        },
      },
    };
    const kind = workerKinds.get(request.command);
    const { ctx, invokeNode } = createCtx({
      command: request.command,
      params: request.params as Record<string, unknown>,
      pluginConfig: api.config.plugins!.entries!["file-transfer"]!.config,
    });
    invokeNode.mockImplementation(async (options = {}) => {
      const { params } = options;
      request.assertCurrent?.();
      signal.throwIfAborted();
      let payload: unknown;
      if (kind) {
        const node = createTestPluginApi({
          config: { agents: { defaults: { workspace: remote } } },
          runtime: {
            agent: { resolveAgentWorkspaceDir: () => remote },
          } as unknown as Plugin.OpenClawPluginApi["runtime"],
        });
        payload = JSON.parse(
          await runWorkspace(node, kind, JSON.stringify(params ?? request.params), io),
        );
      } else {
        const handler = request.command === "file.fetch" ? handleFileFetch : handleFileCreate;
        payload = await handler(params as Record<string, unknown>, io);
      }
      return { ok: true, payload };
    });
    const invocation = kind
      ? handleWorkspaceWorkerPolicy(kind, ctx)
      : createFileTransferNodeInvokePolicy().handle(ctx);
    const closed = Promise.resolve(invocation).then((result) => {
      if (!result.ok) {
        throw new Error(`${result.code}: ${result.message}`);
      }
      return result;
    });
    await Promise.race([
      ready.promise,
      closed.then(() => {
        throw new Error("closed before upload ready");
      }),
    ]);
    return {
      send: async (message) => {
        request.assertCurrent?.();
        signal.throwIfAborted();
        if (!receive) {
          throw new Error("input receiver missing");
        }
        await receive(message);
        if (message.byteLength) {
          afterChunk?.();
        }
      },
      onMessage: (listener) => {
        acknowledge = listener;
        return () => {
          acknowledge = undefined;
        };
      },
      close: () => controller.abort(new Error("test connection closed")),
      closed,
    };
  };
}
