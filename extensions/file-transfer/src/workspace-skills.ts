import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { handleDirFetch } from "./node-host/dir-fetch.js";
import { createWorkspaceFile } from "./workspace-file-create.js";
import { runNodeWorkspaceWorker, type NodeWorkspaceWorkerOptions } from "./workspace-worker.js";

const MAX_PAIRING_CHANGE_RETRIES = 2;

function isPairingChange(error: unknown): boolean {
  const record = asOptionalRecord(error);
  return record?.retryable === true && asOptionalRecord(record.details)?.code === "PAIRING_CHANGED";
}

type SkillsAccess = Required<
  Pick<
    AgentWorkspaceAccess,
    | "loadSkills"
    | "watchSkills"
    | "skillResources"
    | "installSkillDependencies"
    | "applySkillRoot"
    | "recordSkillSourceInstall"
    | "clawHubSkills"
  >
>;

/** Native Skills retain discovery and installation; this adapter supplies node IO. */
export function createNodeWorkspaceSkills(options: NodeWorkspaceWorkerOptions): SkillsAccess {
  function workspace(value: string) {
    if (path.resolve(value) !== options.workspaceDir) {
      throw new Error("Skill request does not match the configured workspace");
    }
    return options.remoteRoot;
  }
  async function interactive<T>(
    operation: string,
    request: unknown,
    decide: (event: Record<string, unknown>) => Promise<unknown>,
    beforeStart?: () => Promise<void>,
  ): Promise<T> {
    let completed: { result: T } | undefined;
    await runNodeWorkspaceWorker(
      options,
      "workspace.skills",
      {
        operation,
        request: JSON.stringify(request),
        watch: false,
      },
      options.signal,
      async (line, reply) => {
        const event = asOptionalRecord(JSON.parse(line));
        if (event?.type === "prepared") {
          let decision: unknown;
          try {
            decision = await decide(event);
            options.signal.throwIfAborted();
          } catch (error) {
            decision = { error: String(error), failureKind: "unavailable" };
          }
          if (!reply) {
            throw new Error("Skill lifecycle requires duplex replies");
          }
          await reply({ decision: decision ?? null });
        } else if (event?.type === "result" && !completed) {
          // SAFETY: Same-version applyRoot/removeSkill emit their native owner's result; the event discriminator is checked above.
          completed = { result: event.result as T };
        } else {
          throw new Error("Invalid Skill lifecycle response");
        }
      },
      beforeStart,
    );
    if (!completed) {
      throw new Error("Skill lifecycle ended without a result");
    }
    return completed.result;
  }
  const tracking = <T>(operation: string, params: { workspaceDir: string }) =>
    call<T>(operation, { ...params, workspaceDir: workspace(params.workspaceDir) });
  const mapPath = (value: string) => {
    const relative = path.relative(options.workspaceDir, value);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.posix.join(options.remoteRoot, ...relative.split(path.sep))
      : value;
  };
  const mapSources = (request: Parameters<SkillsAccess["watchSkills"]>[0]) => {
    if (path.resolve(request.sourcePlan.workspaceDir) !== options.workspaceDir) {
      throw new Error("Skill request does not match the configured workspace");
    }
    const plan = request.sourcePlan;
    return {
      ...request,
      executionWorkspaceDir:
        request.executionWorkspaceDir && mapPath(request.executionWorkspaceDir),
      sourcePlan: {
        ...plan,
        workspaceDir: options.remoteRoot,
        stateDir: plan.stateDir && mapPath(plan.stateDir),
        managedSkillsDir: mapPath(plan.managedSkillsDir),
        pluginSkillsDir: plan.pluginSkillsDir && mapPath(plan.pluginSkillsDir),
        bundledSkillsDir: plan.bundledSkillsDir && mapPath(plan.bundledSkillsDir),
        roots: plan.roots.map((root) => ({ ...root, dir: mapPath(root.dir) })),
        pluginSkillRoots: plan.pluginSkillRoots.map((root) => ({
          ...root,
          dir: mapPath(root.dir),
        })),
        allowSymlinkTargets: plan.allowSymlinkTargets?.map(mapPath),
      },
    };
  };
  async function call<T>(operation: string, request: unknown, signal?: AbortSignal): Promise<T> {
    const active = signal ? AbortSignal.any([options.signal, signal]) : options.signal;
    const text = await runNodeWorkspaceWorker(
      options,
      "workspace.skills",
      {
        operation,
        request: JSON.stringify(request),
        watch: false,
      },
      active,
    );
    const value = JSON.parse(text);
    if (!operation.startsWith("clawhub")) {
      return value;
    }
    const envelope = asOptionalRecord(value);
    if (typeof envelope?.error === "string") {
      throw new Error(envelope.error);
    }
    if (!envelope || !("result" in envelope)) {
      throw new Error("Invalid Skill tracking response");
    }
    // SAFETY: The same-version workspace.skills worker serializes the selected native ClawHub result; the envelope is checked above.
    return envelope.result as T;
  }
  async function read<T>(operation: string, request: unknown, signal?: AbortSignal): Promise<T> {
    // Pairing approvals advance the generation and node.invoke returns retryable PAIRING_CHANGED.
    // Retry reads against the new generation; revoked nodes still fail after the bound.
    for (let retries = 0; ; retries += 1) {
      try {
        return await call<T>(operation, request, signal);
      } catch (error) {
        if (!isPairingChange(error) || retries >= MAX_PAIRING_CHANGE_RETRIES) {
          throw error;
        }
      }
    }
  }
  return {
    async applySkillRoot(params) {
      workspace(params.workspaceDir);
      params.beforePersistentApply?.();
      // Reuse the file plugin's bounded archive producer and binary upload protocol.
      const archive = await handleDirFetch({ path: params.extractedRoot, followSymlinks: false });
      if (!archive.ok) {
        throw new Error(archive.message);
      }
      const sourceArchive = path.posix.join(
        options.remoteRoot,
        ".openclaw/skill-installs",
        `${randomUUID()}.tgz`,
      );
      const assertCurrent = () => {
        options.signal.throwIfAborted();
        params.beforePersistentApply?.();
      };
      const {
        beforeInstall,
        beforePersistentApply: _guard,
        logger: _logger,
        extractedRoot: _source,
        ...files
      } = params;
      return await interactive(
        "applyRoot",
        { ...files, workspaceDir: options.remoteRoot, sourceArchive },
        async (event) => {
          if (event.phase === "apply") {
            assertCurrent();
            return null;
          }
          if (event.mode !== "install" && event.mode !== "update") {
            throw new Error("Invalid Skill installation mode");
          }
          assertCurrent();
          const decision = await beforeInstall?.(event.mode);
          assertCurrent();
          return decision;
        },
        async () => {
          const uploaded = await createWorkspaceFile({
            ...options,
            path: sourceArchive,
            data: Buffer.from(archive.tarBase64, "base64"),
            mkdir: true,
            assertCurrent,
          });
          const payload = asOptionalRecord(asOptionalRecord(uploaded.result)?.payload);
          if (payload?.ok !== true || payload.sha256 !== archive.sha256) {
            throw new Error("Skill upload receipt does not match the source archive");
          }
          assertCurrent();
        },
      );
    },
    recordSkillSourceInstall: (params) => tracking("recordSource", params),
    clawHubSkills: {
      resolveClawHubSkillVerificationTarget: (params) => tracking("clawhubVerifyTarget", params),
      preflightSkillOwnerState: (params) => tracking("clawhubPreflight", params),
      resolveRequestedUpdateSlug: (params) => tracking("clawhubUpdateSlug", params),
      resolveTrackedUpdateTarget: (params) => tracking("clawhubUpdateTarget", params),
      readClawHubSkillsLockfile: (workspaceDir) => tracking("clawhubReadLock", { workspaceDir }),
      recordClawHubSkillInstall: (params) => tracking("clawhubRecordInstall", params),
      assertClawHubSkillInstallState: (params) => tracking("clawhubCheckInstall", params),
      readInstalledClawHubSkillFiles: (params) => call("clawhubReadFiles", params),
      planClawHubSkillUninstall: (params) => tracking("clawhubPlanRemoval", params),
      guardTrackedSkillLocalState: (params) => tracking("clawhubUpdateGuard", params),
      applyClawHubSkillUninstall: (plan, callbacks) =>
        interactive(
          "removeSkill",
          { plan, reportChange: Boolean(callbacks.onCommittedChange) },
          async (event) => {
            if (event.phase === "committed") {
              // SAFETY: removeSkill forwards the native uninstall owner's committed event; only its workspace path is translated for the hook.
              const committed = event.event as Parameters<
                NonNullable<typeof callbacks.onCommittedChange>
              >[0];
              await callbacks.onCommittedChange?.({
                ...committed,
                workspaceDir: options.workspaceDir,
              });
            } else if (event.phase === "rollback") {
              callbacks.beforeRollback?.();
            } else if (event.phase === "apply") {
              callbacks.beforePersistentApply?.();
            } else {
              throw new Error("Invalid Skill removal checkpoint");
            }
            return null;
          },
        ),
    },
    loadSkills: (request) => read("discovery", mapSources(request)),
    async watchSkills(request, onChange, signal) {
      await runNodeWorkspaceWorker(
        options,
        "workspace.skills",
        {
          operation: "watch",
          request: JSON.stringify(mapSources(request)),
          watch: true,
        },
        AbortSignal.any([options.signal, signal]),
        (line) => {
          const event: unknown = JSON.parse(line);
          if (event !== "change" && event !== "unavailable" && event !== "available") {
            throw new Error("Invalid Skill change notification");
          }
          onChange(event);
        },
      );
    },
    // Resource identities already belong to the node that discovered the Skills.
    skillResources: {
      readInstructions: (filePath, { signal }) => read("readInstructions", { filePath }, signal),
      resolveExplicitSkill: (selection) => read("resolveResource", selection),
      readSkillFiles: (skill, { allowMissingRoot }) =>
        read("readResources", { skill, allowMissingRoot }),
    },
    installSkillDependencies: (request) => call("installDependencies", request),
  };
}
