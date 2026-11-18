/** Manifest-light commands for an explicitly enrolled dedicated worker. */
import fs from "node:fs";
import path from "node:path";
import { parseWorkerGitHubLaunchBinding } from "openclaw/plugin-sdk/github-worker-runtime";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexWorkerAppServerCommand } from "./node-app-server-command.js";
import { parseCodexNodePlacementWorkspace } from "./node-exec-server.js";

function parseRequest(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !["placement", "authorization", "resourcePreparationRequired", "github"].includes(key),
    ) ||
    value.authorization !== "session-full" ||
    (value.resourcePreparationRequired !== undefined && value.resourcePreparationRequired !== true)
  ) {
    throw new Error("Worker Codex requires an exact Full placement request");
  }
  const github =
    value.github === undefined ? undefined : parseWorkerGitHubLaunchBinding(value.github);
  if (value.github !== undefined && !github) {
    throw new Error("Worker GitHub binding is invalid");
  }
  return {
    github: github ?? undefined,
    workspace: parseCodexNodePlacementWorkspace(value.placement),
    resourcePreparationRequired: value.resourcePreparationRequired === true,
  };
}

export function createCodexNodeAppServerCommand(): OpenClawPluginNodeHostCommand {
  const activeProcesses = new Set<() => Promise<void>>();
  const command = resolveCodexWorkerAppServerCommand();
  return {
    command,
    cap: "codex.app-server",
    dangerous: true,
    duplex: true,
    isAvailable: ({ env }) =>
      fs.existsSync(path.join(resolveStateDir(env), "codex-runtime", "version")),
    prepare: async ({ env }) => {
      if (!fs.existsSync(path.join(resolveStateDir(env), "codex-runtime", "version"))) {
        return;
      }
      const { readWorkerCodexRuntime } = await import("./node-app-server.runtime.js");
      await readWorkerCodexRuntime(command);
    },
    hasActiveWork: () => activeProcesses.size > 0,
    onDisconnect: async () => {
      await Promise.all([...activeProcesses].map((stop) => stop()));
    },
    handle: async (paramsJSON, io, context) => {
      if (
        !io?.frames ||
        !context?.prepareExecAuthorization ||
        !context.acquireManagedWorkspaceAsync
      ) {
        throw new Error("Worker Codex requires duplex workspace authority");
      }
      const request = parseRequest(JSON.parse(paramsJSON ?? "null"));
      if (context.sessionKey !== request.workspace.sessionKey) {
        throw new Error("Worker Codex session authority changed");
      }
      const signal = context.signal ? AbortSignal.any([io.signal, context.signal]) : io.signal;
      signal.throwIfAborted();
      const assertExecAuthorized = context.prepareExecAuthorization("session-full");
      const { runCodexNodeAppServer } = await import("./node-app-server.runtime.js");
      signal.throwIfAborted();
      assertExecAuthorized();
      const workspace = await context.acquireManagedWorkspaceAsync(request.workspace);
      return await runCodexNodeAppServer({
        command,
        workspace,
        io: { ...io, signal },
        activeProcesses,
        assertExecAuthorized,
        sessionId: request.workspace.sessionId,
        github: request.github,
        resourcePreparationRequired: request.resourcePreparationRequired,
      });
    },
  };
}

export function createCodexNodeAppServerInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [resolveCodexWorkerAppServerCommand()],
    dangerous: true,
    standingApproval: { kind: "placement", scope: "codex.app-server" },
    classifyRisk: () => ({ level: "high", family: "codex.app-server" }),
    handle: async (context) => {
      const denied = {
        ok: false as const,
        code: "CODEX_WORKER_PLACEMENT_REQUIRED",
        message: "Worker Codex requires a current Full placement.",
      };
      if (context.risk?.level !== "high") {
        return denied;
      }
      let request: ReturnType<typeof parseRequest>;
      try {
        request = parseRequest(context.params);
      } catch {
        return denied;
      }
      const { workspace, resourcePreparationRequired, github } = request;
      return (
        (await context.invokeNodeWithSessionFull?.({
          workspace,
          createParams: () => ({
            authorization: "session-full",
            placement: {
              cwd: workspace.workspaceDir,
              environmentId: workspace.environmentId,
              sessionId: workspace.sessionId,
              sessionKey: workspace.sessionKey,
              ownerEpoch: workspace.ownerEpoch,
            },
            ...(github ? { github } : {}),
            ...(resourcePreparationRequired ? { resourcePreparationRequired: true } : {}),
          }),
        })) ?? denied
      );
    },
  };
}
