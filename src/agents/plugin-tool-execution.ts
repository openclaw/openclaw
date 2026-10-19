import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { runOutsideCommandProcessScope } from "../process/exec-spawn.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { SkillSnapshot } from "../skills/types.js";
import {
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./sandbox/constants.js";
import { resolveProtectedSandboxDirectory } from "./sandbox/fs-paths.js";
import { prepareSandboxProcessCleanup } from "./sandbox/process-cleanup.js";
import { shellEscape } from "./sandbox/remote-shell-command.js";
import type { SandboxContext } from "./sandbox/types.js";
import { assertCompleteToolResult, resolveToolResultBudget } from "./tool-result-limits.js";
import { canonicalizePath } from "./utils/paths.js";

export type PluginToolExecutionCapabilities = Pick<
  OpenClawPluginToolContext,
  "sandbox" | "modelExecution" | "assertCompleteResult"
>;

/** Capture once at assembly; a retained plugin never resolves a later run's sandbox or identity. */
export function preparePluginToolExecutionCapabilities(params: {
  sandbox?: SandboxContext | null;
  skillsSnapshot?: SkillSnapshot;
  signal?: AbortSignal;
  authority?: AdmittedRunOperatorAuthority;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  config?: OpenClawConfig;
  agentId?: string;
  modelContextWindowTokens?: number;
}): (assertInvocationCurrent: () => void, signal?: AbortSignal) => PluginToolExecutionCapabilities {
  const sandbox = params.sandbox;
  const backend = sandbox?.backend;
  const workspaceDir = sandbox?.workspaceCwd
    ? sandbox.fsBridge?.resolvePath({ filePath: sandbox.workspaceCwd, cwd: sandbox.workspaceDir })
        .containerPath
    : sandbox?.containerWorkdir;
  const authority = params.authority;
  const hostRoot = authority
    ? resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })
    : null;
  const installedSkillRoots: Record<string, string> = {};
  if (sandbox && backend?.capabilities?.readOnlyResourceMounts) {
    const snapshot = params.skillsSnapshot;
    for (const skill of snapshot?.discoverySkills ?? snapshot?.resolvedSkills ?? []) {
      if (
        ![
          "openclaw-managed",
          "openclaw-library",
          "openclaw-bundled",
          "agents-skills-personal",
        ].includes(skill.source) ||
        skill.disableModelInvocation ||
        skill.fileHost === "workspace"
      ) {
        continue;
      }
      // Prompt preparation remaps filePath; selection retains the canonical source identity.
      const source = snapshot?.skills.find((entry) => entry.name === skill.name)?.source;
      if (source?.fileHost === "workspace") {
        continue;
      }
      const selectedSourceFile = source?.filePath ?? skill.filePath;
      const sourceFile = canonicalizePath(selectedSourceFile);
      const usage = sandbox.skillUsagePaths?.find(
        (entry) => entry.skillName === skill.name && entry.skillFile === sourceFile,
      );
      if (!usage) {
        continue;
      }
      const root = resolveProtectedSandboxDirectory(
        sandbox,
        path.dirname(usage.readPath),
        path.dirname(selectedSourceFile),
      );
      if (root) {
        installedSkillRoots[skill.name] = root;
      }
    }
  }
  const resultBudget = resolveToolResultBudget(params.modelContextWindowTokens);
  return (assertInvocationCurrent, pluginSignal) => ({
    assertCompleteResult(text) {
      assertInvocationCurrent();
      assertCompleteToolResult(text, resultBudget);
    },
    ...(authority && hostRoot
      ? {
          modelExecution: {
            cliEntryPath: path.join(hostRoot, "openclaw.mjs"),
            async run(selection, action, signal) {
              const callerSignal = AbortSignal.any(
                [params.signal, pluginSignal, signal, authority.signal].filter(
                  (value): value is AbortSignal => Boolean(value),
                ),
              );
              const assertCallerCurrent = () => {
                callerSignal.throwIfAborted();
                assertInvocationCurrent();
                authority.assertCurrent();
              };
              assertCallerCurrent();
              const [
                { resolveAmbientOwnerAgentId },
                { resolveDefaultModelForAgent },
                { resolveModelRefFromString },
                { createModelVisibilityPolicy },
                { resolveOperatorModelDefault },
              ] = await Promise.all([
                import("./agent-scope-config.js"),
                import("./model-selection-config.js"),
                import("./model-selection-resolve.js"),
                import("./model-visibility-policy.js"),
                import("./operator-model-policy.js"),
              ]);
              assertCallerCurrent();
              const cfg = params.config ?? {};
              const agentId = resolveAmbientOwnerAgentId(cfg, params.agentId);
              const modelContext = {
                cfg,
                agentId,
                manifestPlugins: params.preparedModelRuntime?.metadataSnapshot,
              };
              const primary = resolveDefaultModelForAgent(modelContext);
              const visibility = createModelVisibilityPolicy({
                ...modelContext,
                catalog: params.preparedModelRuntime?.modelCatalog.entries ?? [],
                defaultProvider: primary.provider,
                defaultModel: primary,
              });
              const requested =
                selection.model === null
                  ? primary
                  : resolveModelRefFromString({
                      ...modelContext,
                      raw: selection.model,
                      defaultProvider: primary.provider,
                      aliasIndex: visibility.selectionAliasIndex,
                    })?.ref;
              const allowed =
                requested &&
                (visibility.allows(requested)
                  ? requested
                  : selection.explicit
                    ? undefined
                    : visibility.resolveSelection({ ...primary, routeResolution: "resolved" }));
              if (!allowed) {
                throw new Error("No permitted reviewer model is available for this agent.");
              }
              const selected = selection.explicit
                ? allowed
                : resolveOperatorModelDefault({
                    ...modelContext,
                    policy: authority.modelPolicy,
                    model: allowed,
                    allows: visibility.allows,
                  });
              if (!selected) {
                throw new Error("No permitted reviewer model is available for this caller.");
              }
              const scope = bindOperatorModelExecution(authority, selected)!;
              const combined = AbortSignal.any([scope.signal, callerSignal]);
              const assertCurrent = () => {
                combined.throwIfAborted();
                assertCallerCurrent();
                scope.assertCurrent();
              };
              try {
                assertCurrent();
                const result = await action({
                  signal: combined,
                  assertCurrent,
                  model: `${selected.provider}/${selected.model}`,
                  agentId,
                });
                assertCurrent();
                return result;
              } finally {
                scope.release();
              }
            },
          },
        }
      : {}),
    ...(backend && workspaceDir
      ? {
          sandbox: {
            workspaceDir,
            installedSkillRoots: Object.freeze(installedSkillRoots),
            async run({ argv, input, signal, maxOutputBytes = 4_000_000 }) {
              const combined = AbortSignal.any(
                [params.signal, pluginSignal, signal].filter((value): value is AbortSignal =>
                  Boolean(value),
                ),
              );
              const assertCurrent = () => {
                combined.throwIfAborted();
                assertInvocationCurrent();
              };
              assertCurrent();
              if (
                !Number.isSafeInteger(maxOutputBytes) ||
                maxOutputBytes < 1 ||
                maxOutputBytes > SANDBOX_COMMAND_MAX_BUFFER_BYTES
              ) {
                throw new Error("Sandbox command output limit is outside the supported range.");
              }
              const cleanup = prepareSandboxProcessCleanup(backend, {});
              const spec = await backend.buildExecSpec({
                command: argv.map(shellEscape).join(" "),
                workdir: workspaceDir,
                env: cleanup.env,
                usePty: false,
                stdin: input !== undefined,
              });
              let completed = false;
              let exitCode: number | null = null;
              let timedOut = false;
              await using resources = new AsyncDisposableStack();
              resources.defer(async () => {
                await backend.finalizeExec?.({
                  status: completed ? "completed" : "failed",
                  exitCode,
                  timedOut,
                  token: spec.finalizeToken,
                });
              });
              resources.defer(async () => {
                if (!completed) {
                  await runOutsideCommandProcessScope(() => cleanup.terminate());
                }
              });
              assertCurrent();
              spec.assertCurrent?.();
              if (input !== undefined && spec.stdinMode !== "pipe-open") {
                throw new Error("This sandbox backend does not support piped command input.");
              }
              const result = await runCommandWithTimeout(spec.argv, {
                cwd: spec.cwd,
                baseEnv: spec.env,
                input: input ?? "",
                signal: combined,
                killProcessTree: true,
                maxOutputBytes,
                outputCapture: "head",
                terminateOnOutputLimit: true,
              });
              completed =
                result.termination === "exit" &&
                !result.outputLimitExceeded &&
                !result.stdoutTruncatedBytes &&
                !result.stderrTruncatedBytes &&
                result.cleanup !== "uncertain";
              exitCode = result.code;
              timedOut = result.termination === "timeout";
              assertCurrent();
              if (!completed) {
                throw new Error(`Sandbox command did not complete (${result.termination}).`);
              }
              return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? 1 };
            },
          },
        }
      : {}),
  });
}
