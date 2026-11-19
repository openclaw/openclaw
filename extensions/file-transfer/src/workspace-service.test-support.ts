import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import type * as Plugin from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import plugin from "../index.js";
import { duplexPeer } from "./node-host/node-host.test-support.js";
import { createCtx } from "./shared/node-invoke-policy.test-support.js";

/** Use the plugin's registrations instead of maintaining a parallel command router. */
export function createWorkspaceNodeDispatcher(remote: string) {
  const commands = new Map(plugin.nodeHostCommands!.map((command) => [command.command, command]));
  const policies = new Map<string, Plugin.OpenClawPluginNodeInvokePolicy>();
  plugin.register(
    createTestPluginApi({
      config: { agents: { defaults: { workspace: remote } } },
      runtime: {
        agent: { resolveAgentWorkspaceDir: () => remote },
      } as unknown as Plugin.OpenClawPluginApi["runtime"],
      registerNodeHostCommand: (command) => {
        commands.set(command.command, command);
      },
      registerNodeInvokePolicy: (policy) => {
        for (const command of policy.commands) {
          policies.set(command, policy);
        }
      },
    }),
  );
  return async (
    request: { command: string; params?: unknown; assertCurrent?: () => void },
    pluginConfig?: Record<string, unknown>,
    io?: OpenClawPluginNodeHostCommandIo,
  ) => {
    const { ctx, invokeNode } = createCtx({
      command: request.command,
      params: request.params as Record<string, unknown>,
      pluginConfig,
    });
    invokeNode.mockImplementation(async (options: Parameters<typeof invokeNode>[0] = {}) => {
      const { params } = options;
      request.assertCurrent?.();
      io?.signal.throwIfAborted();
      const command = commands.get(request.command);
      if (!command) {
        throw new Error(`Unexpected command ${request.command}`);
      }
      return {
        ok: true,
        payload: JSON.parse(await command.handle(JSON.stringify(params ?? request.params), io)),
      };
    });
    const result = await policies.get(request.command)!.handle(ctx);
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result;
  };
}

/** Real policy and file handlers; only the paired connection is replaced here. */
export function createNodeWorkspaceTestTransport(
  api: Plugin.OpenClawPluginApi,
  remote: string,
  afterChunk?: () => void,
  onOutput?: (bytes: Uint8Array) => void,
): NonNullable<Plugin.OpenClawPluginServiceContext["openNodeDuplex"]> {
  const invoke = createWorkspaceNodeDispatcher(remote);
  return async (request) => {
    const peer = duplexPeer();
    const { controller } = peer;
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;
    let acknowledge: ((message: Uint8Array) => void | Promise<void>) | undefined;
    const io: OpenClawPluginNodeHostCommandIo = { ...peer.io, signal };
    peer.send.mockImplementation(async (message) => {
      onOutput?.(message);
      await acknowledge?.(message);
    });
    const closed = invoke(request, api.config.plugins!.entries!["file-transfer"]!.config, io);
    await Promise.race([
      peer.ready,
      closed.then(() => {
        throw new Error("closed before upload ready");
      }),
    ]);
    return {
      send: async (message) => {
        request.assertCurrent?.();
        signal.throwIfAborted();
        await peer.receive(message);
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
