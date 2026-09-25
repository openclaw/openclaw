import path from "node:path";
import {
  createWorkspaceAttachmentPreparer,
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function readWorkspaces(config: unknown) {
  const workspaces = asOptionalRecord(asOptionalRecord(config)?.workspaces) ?? {};
  return Object.entries(workspaces).map(([agentId, value]) => {
    const entry = asOptionalRecord(value);
    if (
      !entry ||
      typeof entry.nodeId !== "string" ||
      !entry.nodeId.trim() ||
      typeof entry.remoteRoot !== "string" ||
      !path.posix.isAbsolute(entry.remoteRoot) ||
      entry.remoteRoot.includes("\0")
    ) {
      throw new Error(`Invalid file-transfer workspace configuration for ${agentId}`);
    }
    return { agentId, nodeId: entry.nodeId, remoteRoot: path.posix.resolve(entry.remoteRoot) };
  });
}

export function registerNodeWorkspaces(api: OpenClawPluginApi): void {
  if (api.registrationMode !== "full") {
    return;
  }
  for (const { agentId } of readWorkspaces(api.pluginConfig)) {
    declareAgentWorkspaceAccess(api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId));
  }
  let lifetime: AbortController | undefined;
  const releases: (() => void)[] = [];
  const stop = () => {
    lifetime?.abort(new Error("Node workspace service stopped"));
    for (const release of releases.splice(0)) {
      release();
    }
  };
  api.registerService({
    id: "file-transfer-workspaces",
    reload: { configPrefixes: ["plugins.entries.file-transfer.config.workspaces", "agents"] },
    async start(ctx) {
      stop();
      const controller = new AbortController();
      lifetime = controller;
      const configured = readWorkspaces(ctx.config.plugins?.entries?.["file-transfer"]?.config).map(
        (entry) => ({
          agentId: entry.agentId,
          nodeId: entry.nodeId,
          remoteRoot: entry.remoteRoot,
          workspaceDir: path.resolve(
            api.runtime.agent.resolveAgentWorkspaceDir(ctx.config, entry.agentId),
          ),
        }),
      );
      for (const entry of configured) {
        declareAgentWorkspaceAccess(entry.workspaceDir);
      }
      if (configured.length === 0) {
        return;
      }
      try {
        const bindings = new Map<string, (typeof configured)[number]>();
        for (const entry of configured) {
          const previous = bindings.get(entry.workspaceDir);
          if (
            previous &&
            (previous.nodeId !== entry.nodeId || previous.remoteRoot !== entry.remoteRoot)
          ) {
            throw new Error(`Conflicting node workspace mappings for ${entry.workspaceDir}`);
          }
          bindings.set(entry.workspaceDir, entry);
        }
        const invoke = ctx.invokeNode;
        if (!invoke) {
          throw new Error("Node workspaces require Gateway service node access");
        }
        const { createNodeWorkspaceBridge } = await import("./workspace-bridge.js");
        const { createNodeWorkspaceMemory } = await import("./workspace-memory.js");
        const { createNodeWorkspaceSkills } = await import("./workspace-skills.js");
        controller.signal.throwIfAborted();
        for (const entry of bindings.values()) {
          const bridge = createNodeWorkspaceBridge({
            ...entry,
            invoke,
            signal: controller.signal,
            openDuplex: ctx.openNodeDuplex,
          });
          releases.push(
            registerAgentWorkspaceAccess(entry.workspaceDir, {
              ...(ctx.openNodeDuplex
                ? {
                    ...createNodeWorkspaceSkills({
                      ...entry,
                      signal: controller.signal,
                      openDuplex: ctx.openNodeDuplex,
                    }),
                    memoryFiles: createNodeWorkspaceMemory({
                      ...entry,
                      signal: controller.signal,
                      openDuplex: ctx.openNodeDuplex,
                    }),
                  }
                : {}),
              ...(ctx.openNodeDuplex
                ? {
                    prepareTurnAttachments: createWorkspaceAttachmentPreparer({
                      remoteRoot: entry.remoteRoot,
                      createBridge: (assertCurrent, signal) =>
                        createNodeWorkspaceBridge({
                          ...entry,
                          invoke,
                          signal: AbortSignal.any([controller.signal, signal]),
                          openDuplex: ctx.openNodeDuplex,
                          assertCurrent,
                        }),
                    }),
                  }
                : {}),
              bridge,
              outboundMedia: {
                localRoots: [entry.workspaceDir],
                readFile: (filePath, maxBytes) =>
                  bridge.readFile({ filePath, cwd: entry.workspaceDir, maxBytes }),
              },
            }),
          );
        }
      } catch (error) {
        if (lifetime === controller) {
          stop();
        }
        throw error;
      }
    },
    stop,
  });
}
