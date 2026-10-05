import fs from "node:fs";
import path from "node:path";
import type { WorkerGitHubLaunchBinding } from "openclaw/plugin-sdk/github-worker-runtime";
/** Declares the explicitly approved, lazily loaded node-backed Codex exec-server. */
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexWorkerAppServerCommand } from "./node-app-server-command.js";
import { CODEX_NODE_GITHUB_REFRESH_FEATURE } from "./node-github-refresh.js";
import { CODEX_NODE_RESOURCE_READINESS_FEATURE } from "./node-resource-readiness.js";

const CODEX_NODE_EXEC_SERVER_COMMAND = "codex.exec-server.stdio.v1";

const CODEX_NODE_EXEC_SERVER_CAPABILITY = "codex.exec-server";
const CODEX_NODE_APP_SERVER_CAPABILITY = "codex.app-server";

async function parseCodexNodeGitHubBinding(
  value: unknown,
): Promise<WorkerGitHubLaunchBinding | undefined> {
  // Registration must not load Gateway credential and session runtime.
  const { parseWorkerGitHubLaunchBinding } =
    await import("openclaw/plugin-sdk/github-worker-runtime");
  return parseWorkerGitHubLaunchBinding(value);
}

function parseCodexNodePlacementWorkspace(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    typeof value.cwd !== "string" ||
    !value.cwd.trim() ||
    value.cwd.includes("\0") ||
    typeof value.environmentId !== "string" ||
    typeof value.sessionId !== "string" ||
    ![value.environmentId, value.sessionId].every(
      (identifier) =>
        identifier.length > 0 &&
        identifier.length <= 256 &&
        identifier.trim() === identifier &&
        !identifier.includes("\0"),
    ) ||
    typeof value.sessionKey !== "string" ||
    !value.sessionKey ||
    value.sessionKey.trim() !== value.sessionKey ||
    value.sessionKey.includes("\0") ||
    typeof value.ownerEpoch !== "number" ||
    !Number.isSafeInteger(value.ownerEpoch) ||
    value.ownerEpoch < 1
  ) {
    throw new Error("Codex node exec-server requires an exact managed placement workspace.");
  }
  return {
    cwd: value.cwd,
    environmentId: value.environmentId,
    sessionId: value.sessionId,
    ownerEpoch: value.ownerEpoch,
    sessionKey: value.sessionKey,
  };
}

/** The node advertises model hosting only after enrollment staged private settings. */
function hasCodexNodeAppServerConfiguration(env: NodeJS.ProcessEnv = process.env): boolean {
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    return false;
  }
  const directory = path.join(stateDir, "codex-runtime");
  try {
    return ["version", "config.toml", "autodev-token.mjs"].every((name) =>
      fs.statSync(path.join(directory, name)).isFile(),
    );
  } catch {
    return false;
  }
}

/** Runs one placement-bound native model process over the existing node duplex. */
export function createCodexNodeAppServerCommand(): OpenClawPluginNodeHostCommand {
  const activeProcesses = new Set<() => Promise<void>>();
  const command = resolveCodexWorkerAppServerCommand();
  return {
    command,
    cap: CODEX_NODE_APP_SERVER_CAPABILITY,
    features: [CODEX_NODE_RESOURCE_READINESS_FEATURE],
    dangerous: true,
    duplex: true,
    isAvailable: ({ env }) => hasCodexNodeAppServerConfiguration(env),
    prepare: async ({ env }) => {
      if (!hasCodexNodeAppServerConfiguration(env)) {
        return;
      }
      const { readWorkerCodexRuntime } = await import("./node-app-server.runtime.js");
      await readWorkerCodexRuntime();
      const {
        resolveManagedCodexAppServerStartOptions,
        resolveManagedCodexNativeCommand,
        isManagedCodexDesktopCommand,
      } = await import("./app-server/managed-binary.js");
      const resolved = await resolveManagedCodexAppServerStartOptions({
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        managedCommandOrder: "package-first",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      });
      if (
        !resolveManagedCodexNativeCommand(resolved.command) ||
        isManagedCodexDesktopCommand(resolved.command)
      ) {
        throw new Error("Cloud worker requires its pinned Codex binary");
      }
    },
    hasActiveWork: () => activeProcesses.size > 0,
    onDisconnect: async () => {
      await Promise.all([...activeProcesses].map(async (stop) => await stop()));
    },
    handle: async (paramsJSON, io, context) => {
      if (!io?.frames) {
        throw new Error("Codex node app-server requires duplex frames.");
      }
      let request: unknown;
      try {
        request = JSON.parse(paramsJSON ?? "null") as unknown;
      } catch {
        throw new Error("Codex node app-server requires a valid workspace request.");
      }
      if (
        !isRecord(request) ||
        ![2, 3, 4, 5].includes(Object.keys(request).length) ||
        Object.keys(request).some(
          (key) =>
            ![
              "authorization",
              "placement",
              "github",
              "repositoryPreparationRequired",
              "resourcePreparationRequired",
            ].includes(key),
        ) ||
        request.authorization !== "session-full"
      ) {
        throw new Error("Codex node app-server requires a full managed placement.");
      }
      if (
        request.repositoryPreparationRequired !== undefined &&
        request.repositoryPreparationRequired !== true
      ) {
        throw new Error("Invalid repository preparation requirement");
      }
      if (
        request.resourcePreparationRequired !== undefined &&
        request.resourcePreparationRequired !== true
      ) {
        throw new Error("Invalid private resource preparation requirement");
      }
      const placement = parseCodexNodePlacementWorkspace(request.placement);
      const github: WorkerGitHubLaunchBinding | undefined = Object.hasOwn(request, "github")
        ? await parseCodexNodeGitHubBinding(request.github)
        : undefined;
      if (Object.hasOwn(request, "github") && !github) {
        throw new Error("Codex node app-server received an invalid GitHub process binding.");
      }
      if (
        !context?.acquireManagedWorkspaceAsync ||
        !context.prepareExecAuthorization ||
        context.sessionKey !== placement.sessionKey ||
        io.signal.aborted
      ) {
        throw new Error("Codex node app-server requires active managed placement authority.");
      }
      const runtimeIo = context.signal
        ? { ...io, signal: AbortSignal.any([io.signal, context.signal]) }
        : io;
      const assertExecAuthorized = context.prepareExecAuthorization("session-full");
      const { runCodexNodeAppServer } = await import("./node-app-server.runtime.js");
      runtimeIo.signal.throwIfAborted();
      const workspace = await context.acquireManagedWorkspaceAsync({
        workspaceDir: placement.cwd,
        environmentId: placement.environmentId,
        sessionId: placement.sessionId,
        ownerEpoch: placement.ownerEpoch,
        sessionKey: placement.sessionKey,
      });
      if (request.repositoryPreparationRequired && !workspace.repositoryReadiness) {
        workspace.release();
        throw new Error(
          "Repository preparation owner is unavailable; repository execution remains fenced",
        );
      }
      return await runCodexNodeAppServer({
        workspace,
        io: runtimeIo,
        activeProcesses,
        assertExecAuthorized,
        github,
        resourcePreparationRequired: request.resourcePreparationRequired === true,
        sessionId: placement.sessionId,
        placement,
      });
    },
  };
}

export function createCodexNodeAppServerInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [resolveCodexWorkerAppServerCommand()],
    dangerous: true,
    standingApproval: { kind: "placement", scope: CODEX_NODE_APP_SERVER_CAPABILITY },
    classifyRisk: () => ({ level: "high", family: CODEX_NODE_APP_SERVER_CAPABILITY }),
    handle: async (context) => {
      if (context.risk?.level !== "high") {
        return {
          ok: false,
          code: "CODEX_NODE_APP_SERVER_APPROVAL_REQUIRED",
          message: "Codex node model execution requires an available approval reviewer.",
        };
      }
      if (
        !isRecord(context.params) ||
        ![2, 3, 4, 5].includes(Object.keys(context.params).length) ||
        Object.keys(context.params).some(
          (key) =>
            ![
              "placement",
              "authorization",
              "github",
              "repositoryPreparationRequired",
              "resourcePreparationRequired",
            ].includes(key),
        ) ||
        (context.params.repositoryPreparationRequired !== undefined &&
          context.params.repositoryPreparationRequired !== true) ||
        (context.params.resourcePreparationRequired !== undefined &&
          context.params.resourcePreparationRequired !== true) ||
        context.params.authorization !== "session-full"
      ) {
        return {
          ok: false,
          code: "CODEX_NODE_APP_SERVER_WORKSPACE_INVALID",
          message: "Codex node model execution requires an exact managed placement workspace.",
        };
      }
      const repositoryRequired = context.params.repositoryPreparationRequired === true;
      const resourceRequired = context.params.resourcePreparationRequired === true;
      let placement: ReturnType<typeof parseCodexNodePlacementWorkspace>;
      try {
        placement = parseCodexNodePlacementWorkspace(context.params.placement);
      } catch {
        return {
          ok: false,
          code: "CODEX_NODE_APP_SERVER_WORKSPACE_INVALID",
          message: "Codex node model execution requires an exact managed placement workspace.",
        };
      }
      const github = Object.hasOwn(context.params, "github")
        ? await parseCodexNodeGitHubBinding(context.params.github)
        : undefined;
      if (Object.hasOwn(context.params, "github") && !github) {
        return {
          ok: false,
          code: "CODEX_NODE_APP_SERVER_GITHUB_BINDING_INVALID",
          message: "Codex node model execution received an invalid GitHub process binding.",
        };
      }
      const workspace = {
        workspaceDir: placement.cwd,
        environmentId: placement.environmentId,
        sessionId: placement.sessionId,
        ownerEpoch: placement.ownerEpoch,
        sessionKey: placement.sessionKey,
      };
      const launched = await context.invokeNodeWithSessionFull?.({
        workspace,
        createParams: () => ({
          placement,
          authorization: "session-full",
          ...(github ? { github } : {}),
          ...(repositoryRequired ? { repositoryPreparationRequired: true } : {}),
          ...(resourceRequired ? { resourcePreparationRequired: true } : {}),
        }),
      });
      return (
        launched ?? {
          ok: false,
          code: "CODEX_NODE_APP_SERVER_APPROVAL_REQUIRED",
          message: "Codex node model execution requires an active Full placement.",
        }
      );
    },
  };
}

/** Registers the exact pinned exec-server as an explicitly approved duplex node command. */
export function createCodexNodeExecServerCommand(): OpenClawPluginNodeHostCommand {
  const activeProcesses = new Set<() => Promise<void>>();
  return {
    command: CODEX_NODE_EXEC_SERVER_COMMAND,
    cap: CODEX_NODE_EXEC_SERVER_CAPABILITY,
    features: [CODEX_NODE_GITHUB_REFRESH_FEATURE, CODEX_NODE_RESOURCE_READINESS_FEATURE],
    dangerous: true,
    duplex: true,
    hasActiveWork: () => activeProcesses.size > 0,
    onDisconnect: async () => {
      await Promise.all([...activeProcesses].map(async (terminate) => await terminate()));
    },
    handle: async (paramsJSON, io, context) => {
      if (!io?.frames) {
        throw new Error("Codex node exec-server requires duplex frames.");
      }
      let request: unknown;
      try {
        request = JSON.parse(paramsJSON ?? "null") as unknown;
      } catch {
        throw new Error("Codex node exec-server requires a valid workspace request.");
      }
      if (
        !isRecord(request) ||
        ![2, 3, 4, 5].includes(Object.keys(request).length) ||
        Object.keys(request).some(
          (key) =>
            ![
              "placement",
              "authorization",
              "github",
              "resourcePreparationRequired",
              "repositoryPreparationRequired",
            ].includes(key),
        ) ||
        (request.resourcePreparationRequired !== undefined &&
          request.resourcePreparationRequired !== true) ||
        (request.repositoryPreparationRequired !== undefined &&
          request.repositoryPreparationRequired !== true) ||
        (request.authorization !== "human-approved" && request.authorization !== "session-full")
      ) {
        throw new Error(
          "Codex node exec-server requires an authorized managed placement workspace launch.",
        );
      }
      const placement = parseCodexNodePlacementWorkspace(request.placement);
      const github: WorkerGitHubLaunchBinding | undefined = Object.hasOwn(request, "github")
        ? await parseCodexNodeGitHubBinding(request.github)
        : undefined;
      if (Object.hasOwn(request, "github") && !github) {
        throw new Error("Codex node exec-server received an invalid GitHub process binding.");
      }
      if (
        !context?.acquireManagedWorkspaceAsync ||
        context.sessionKey !== placement.sessionKey ||
        io.signal.aborted
      ) {
        throw new Error("Codex node exec-server requires active managed placement authority.");
      }
      if (!context.prepareExecAuthorization) {
        throw new Error(
          "Codex node execution requires node-local exec policy support; update the node.",
        );
      }
      const runtimeIo = context.signal
        ? { ...io, signal: AbortSignal.any([io.signal, context.signal]) }
        : io;
      const assertExecAuthorized = context.prepareExecAuthorization(request.authorization);
      const { runCodexNodeExecServer } = await import("./node-exec-server.runtime.js");
      runtimeIo.signal.throwIfAborted();
      const workspace = await context.acquireManagedWorkspaceAsync({
        workspaceDir: placement.cwd,
        environmentId: placement.environmentId,
        sessionId: placement.sessionId,
        ownerEpoch: placement.ownerEpoch,
        sessionKey: placement.sessionKey,
      });
      try {
        runtimeIo.signal.throwIfAborted();
      } catch (error) {
        workspace.release();
        throw error;
      }
      if (request.repositoryPreparationRequired && !workspace.repositoryReadiness) {
        workspace.release();
        throw new Error(
          "Repository preparation owner is unavailable; repository execution remains fenced",
        );
      }
      return await runCodexNodeExecServer({
        workspace,
        io: runtimeIo,
        activeProcesses,
        assertExecAuthorized,
        github,
        resourcePreparationRequired: request.resourcePreparationRequired === true,
      });
    },
  };
}

/** Keeps node launch behind command opt-in and a live Full owner or human decision. */
export function createCodexNodeExecServerInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [CODEX_NODE_EXEC_SERVER_COMMAND],
    dangerous: true,
    standingApproval: { kind: "placement", scope: CODEX_NODE_EXEC_SERVER_CAPABILITY },
    classifyRisk: () => ({ level: "high", family: CODEX_NODE_EXEC_SERVER_CAPABILITY }),
    handle: async (context) => {
      if (context.risk?.level !== "high") {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_REQUIRED",
          message: "Codex node execution requires an available approval reviewer.",
        };
      }
      const resourceRequired =
        isRecord(context.params) && context.params.resourcePreparationRequired === true;
      const repositoryRequired =
        isRecord(context.params) && context.params.repositoryPreparationRequired === true;
      if (
        isRecord(context.params) &&
        context.params.repositoryPreparationRequired !== undefined &&
        !repositoryRequired
      ) {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_WORKSPACE_INVALID",
          message: "Invalid repository preparation requirement.",
        };
      }
      if (
        isRecord(context.params) &&
        context.params.resourcePreparationRequired !== undefined &&
        !resourceRequired
      ) {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_WORKSPACE_INVALID",
          message: "Invalid private resource preparation requirement.",
        };
      }
      let placement: ReturnType<typeof parseCodexNodePlacementWorkspace>;
      const github =
        isRecord(context.params) && Object.hasOwn(context.params, "github")
          ? await parseCodexNodeGitHubBinding(context.params.github)
          : undefined;
      if (isRecord(context.params) && Object.hasOwn(context.params, "github") && !github) {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_GITHUB_BINDING_INVALID",
          message: "Codex node execution received an invalid GitHub process binding.",
        };
      }
      try {
        placement = parseCodexNodePlacementWorkspace(
          isRecord(context.params)
            ? Object.fromEntries(
                Object.entries(context.params).filter(
                  ([key]) =>
                    key !== "github" &&
                    key !== "resourcePreparationRequired" &&
                    key !== "repositoryPreparationRequired",
                ),
              )
            : context.params,
        );
      } catch {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_WORKSPACE_INVALID",
          message: "Codex node execution requires an exact managed placement workspace.",
        };
      }
      const workspace = {
        workspaceDir: placement.cwd,
        environmentId: placement.environmentId,
        sessionId: placement.sessionId,
        ownerEpoch: placement.ownerEpoch,
        sessionKey: placement.sessionKey,
      };
      const fullLaunch = await context.invokeNodeWithSessionFull?.({
        workspace,
        createParams: () => ({
          placement,
          authorization: "session-full",
          ...(github ? { github } : {}),
          ...(resourceRequired ? { resourcePreparationRequired: true } : {}),
          ...(repositoryRequired ? { repositoryPreparationRequired: true } : {}),
        }),
      });
      if (fullLaunch) {
        return fullLaunch;
      }
      if (!context.approvals) {
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_REQUIRED",
          message: "Codex node execution requires an available approval reviewer.",
        };
      }
      const nodeName = context.node?.displayName ?? context.nodeId;
      const approval = await context.approvals.request({
        title: "Run Codex on this node placement",
        // Keep the risk visible when the Gateway bounds a long workspace description.
        description: `Allows arbitrary processes and filesystem access across the node account, not only this workspace. Allow always applies only while this exact placement remains active. ${nodeName}: ${placement.cwd}`,
        severity: "critical",
        allowedDecisions: ["allow-once", "allow-always"],
      });
      if (approval.decision !== "allow-once" && approval.decision !== "allow-always") {
        if (approval.decision === "deny") {
          return {
            ok: false,
            code: "CODEX_NODE_EXEC_APPROVAL_DENIED",
            message:
              "Codex node execution was denied. Retry the action and choose Allow once or Allow always to continue.",
          };
        }
        return {
          ok: false,
          code: "CODEX_NODE_EXEC_APPROVAL_EXPIRED",
          message:
            "Codex node execution approval expired before a decision. Retry the action and approve the new request.",
        };
      }
      return await context.invokeNode({
        workspace,
        params: {
          placement,
          authorization: "human-approved",
          ...(github ? { github } : {}),
          ...(resourceRequired ? { resourcePreparationRequired: true } : {}),
          ...(repositoryRequired ? { repositoryPreparationRequired: true } : {}),
        },
      });
    },
  };
}
