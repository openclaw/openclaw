import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import {
  bindDockerPersistentTarget,
  dockerPersistentTargetFromEngineTarget,
  dockerPersistentTargetToEngineTarget,
} from "./docker-persistent-target.js";
import {
  bindPodmanSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  validateSandboxContainerEngineTarget,
} from "./docker.js";
import { createSandboxPersistentExecStore } from "./persistent-exec-store.js";
import { dockerPersistentExecContainerName } from "./persistent-exec.types.js";
import {
  readRegistry,
  readBrowserRegistry,
  assertSandboxRegistryRetirementCurrent,
  assertSandboxRegistryEntryCurrent,
  assertSandboxBrowserRegistryEntryCurrent,
} from "./registry.js";

/** Registered runtimes and retained stream children can write the exact private mount. */
export async function readLocalWorkspaceRuntimes(
  workspaceDir: string,
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const custody = createSandboxPersistentExecStore(options);
  const database = {
    path: custody.databasePath,
    env: custody.environment,
    assertCurrent: custody.assertCurrent,
  };
  const [containers, browsers, streams] = await Promise.all([
    readRegistry({ ...database, workspaceDir }),
    readBrowserRegistry({ ...database, workspaceDir }),
    custody.list(),
  ]);
  return [
    ...containers.entries.map((entry) => ({
      kind: "container" as const,
      entry,
      database,
      assertCurrent: () => assertSandboxRegistryRetirementCurrent("container", entry, database),
    })),
    ...browsers.entries.map((entry) => ({
      kind: "browser" as const,
      entry,
      database,
      assertCurrent: () => assertSandboxRegistryRetirementCurrent("browser", entry, database),
    })),
    ...streams.flatMap((record) => {
      const receipt = record.receipt;
      // Preparation and START share the projection lease. Without a published
      // receipt an inert allocation cannot have written this workspace.
      if (record.workspaceBinding.workspaceDir !== workspaceDir || !receipt) {
        return [];
      }
      return [
        {
          kind: "persistent" as const,
          record,
          receipt,
          assertCurrent: () => custody.assertCustodyCurrent(record),
          assertRetired: async () => {
            if ((await custody.list({ ownerKey: record.ownerKey })).length) {
              throw new Error("Settle persistent streams before retiring their workspace.");
            }
          },
        },
      ];
    }),
  ];
}

/** Inspect existing allocation custody; image reads never provision a runtime. */
export async function prepareLocalWorkspaceImageRead(params: {
  workspaceDir: string;
  containerRoot: string;
  targets: readonly string[];
  assertCurrent: () => void;
}) {
  // Stream children are writers to quiesce, not session image namespace authorities.
  // A retained child cannot replace the registered parent after its runtime retires.
  const runtimes = (await readLocalWorkspaceRuntimes(params.workspaceDir)).filter(
    (runtime) => runtime.kind !== "persistent",
  );
  const assertCurrent = () => {
    params.assertCurrent();
    for (const runtime of runtimes) {
      if (runtime.kind === "container") {
        assertSandboxRegistryEntryCurrent(runtime.entry);
      } else {
        assertSandboxBrowserRegistryEntryCurrent(runtime.entry);
      }
    }
  };
  assertCurrent();
  if (!runtimes.length) {
    throw new Error("Sandbox image backing is unavailable");
  }
  const { sandboxContainerShowsWorkspacePaths } = await import("./mount-plan.js");
  for (const runtime of runtimes) {
    const { engine, backendTarget, containerName } = localWorkspaceRuntimeEngine(runtime);
    await validateSandboxContainerEngineTarget(engine, backendTarget);
    assertCurrent();
    if (
      !(await sandboxContainerShowsWorkspacePaths({
        ...params,
        engine,
        containerName,
        assertCurrent,
      }))
    ) {
      throw new Error("Sandbox image backing is unavailable");
    }
  }
  assertCurrent();
  return assertCurrent;
}

function localWorkspaceRuntimeEngine(
  runtime: Awaited<ReturnType<typeof readLocalWorkspaceRuntimes>>[number],
) {
  const containerName =
    runtime.kind === "persistent"
      ? dockerPersistentExecContainerName(runtime.record.attemptId)
      : runtime.entry.containerName;
  const expectedId = runtime.kind === "persistent" ? runtime.receipt.containerId : undefined;
  const backendId = runtime.kind === "container" ? runtime.entry.backendId : "docker";
  const backendTarget =
    runtime.kind === "persistent"
      ? dockerPersistentTargetToEngineTarget(runtime.record.backendTarget)
      : runtime.kind === "container"
        ? runtime.entry.backendTarget
        : undefined;
  if (backendId !== "docker" && backendId !== "podman") {
    throw new Error("Local workspace backend cannot fence host projection writes");
  }
  if (backendId === "podman" && !backendTarget) {
    throw new Error("Local workspace Podman engine owner is missing");
  }
  return {
    engine:
      backendId === "podman"
        ? bindPodmanSandboxEngine(backendTarget!)
        : backendTarget
          ? bindDockerPersistentTarget(dockerPersistentTargetFromEngineTarget(backendTarget))
          : DOCKER_SANDBOX_ENGINE,
    backendTarget,
    containerName,
    expectedId,
  };
}

export type LocalWorkspacePausedRuntime = { name: string; id: string };

export function parseLocalWorkspacePausedRuntimes(
  raw: string | null,
): LocalWorkspacePausedRuntime[] {
  if (!raw) {
    return [];
  }
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("Invalid local workspace runtime custody");
  }
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(entry.name) ||
      typeof entry.id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.id)
    ) {
      throw new Error("Invalid local workspace runtime custody");
    }
    return { name: entry.name, id: entry.id };
  });
}

/** Caller holds the projection lease through pause, reconciliation, and resume. */
export async function quiesceLocalWorkspace(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  retained: LocalWorkspacePausedRuntime[];
  persist: (runtimes: LocalWorkspacePausedRuntime[]) => void | Promise<void>;
  assertCurrent: () => void;
}) {
  using phases = observeDiagnosticsTimelinePhases(
    "attempt.setup.sandbox.workspace_selection.quiesce.registry",
  );
  const selected = (await readLocalWorkspaceRuntimes(params.workspaceDir, { env: params.env })).map(
    (runtime) => ({
      runtime,
      bridges:
        runtime.kind === "browser"
          ? [...BROWSER_BRIDGES].filter(
              ([, bridge]) => bridge.containerName === runtime.entry.containerName,
            )
          : [],
    }),
  );
  params.assertCurrent();
  let paused = [...params.retained];
  let retired = false;
  const releases: Array<() => Promise<void>> = [];
  const retirements: Array<() => Promise<void>> = [];
  for (const { runtime, bridges } of selected) {
    const { engine, backendTarget, containerName, expectedId } =
      localWorkspaceRuntimeEngine(runtime);
    // Stopped allocations remain owned resources, but were never live writers.
    const captureRetirement = (id: string | null) => {
      if (runtime.kind === "persistent") {
        return;
      }
      retirements.push(async () => {
        const { removeSandboxRuntimeGeneration } = await import("./manage.js");
        await removeSandboxRuntimeGeneration({
          runtime,
          database: runtime.database,
          engine,
          id,
          bridges,
          assertCurrent: params.assertCurrent,
          assertGenerationCurrent: runtime.assertCurrent,
        });
      });
    };
    phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.engine_target");
    await validateSandboxContainerEngineTarget(engine, backendTarget);
    params.assertCurrent();
    phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.authority");
    await runtime.assertCurrent();
    phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.inspect");
    const inspect = await execContainer(
      engine,
      [
        "inspect",
        "-f",
        "{{.Id}} {{.State.Running}} {{.State.Paused}}",
        expectedId ?? containerName,
      ],
      { allowFailure: true, signal: AbortSignal.timeout(30_000) },
    );
    params.assertCurrent();
    if (inspect.code !== 0) {
      if (/no such (?:container|object)|does not exist/iu.test(inspect.stderr)) {
        phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.authority");
        await runtime.assertCurrent();
        captureRetirement(null);
        continue;
      }
      throw new Error("Local workspace runtime could not be inspected; workspace preserved");
    }
    const [id, running, isPaused] = inspect.stdout.trim().split(/\s+/u);
    if (
      !id ||
      !/^[a-f0-9]{64}$/u.test(id) ||
      (expectedId !== undefined && id !== expectedId) ||
      !["true", "false"].includes(running ?? "") ||
      !["true", "false"].includes(isPaused ?? "")
    ) {
      throw new Error("Invalid local workspace runtime inspection");
    }
    phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.authority");
    await runtime.assertCurrent();
    captureRetirement(id);
    // Podman reports a paused container as Running=false; its exact retained
    // generation still needs recovery and must not be mistaken for a stopped runtime.
    if (running !== "true" && isPaused !== "true") {
      continue;
    }
    const retained = paused.some(
      (retainedRuntime) => retainedRuntime.name === containerName && retainedRuntime.id === id,
    );
    if (isPaused === "true" && !retained) {
      throw new Error(
        "Local workspace runtime was paused by another owner; resume it before retrying",
      );
    }
    if (!retained) {
      paused.push({ name: containerName, id });
      phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.persist");
      await params.persist(paused);
    }
    if (isPaused !== "true") {
      // A retained receipt may outlive an unpause. Re-fence the live writer
      // before reconciliation rather than trusting stale pause metadata.
      params.assertCurrent();
      phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.authority");
      await runtime.assertCurrent();
      phases.mark("attempt.setup.sandbox.workspace_selection.quiesce.pause");
      await execContainer(engine, ["pause", id], { signal: AbortSignal.timeout(30_000) });
    }
    releases.push(async () => {
      using resumePhases = observeDiagnosticsTimelinePhases(
        "attempt.setup.sandbox.workspace_selection.resume.engine_target",
      );
      await validateSandboxContainerEngineTarget(engine, backendTarget);
      params.assertCurrent();
      // Archive may have removed this exact generation while settlement held it.
      // A missing or already-running runtime needs receipt cleanup, not unpause.
      resumePhases.mark("attempt.setup.sandbox.workspace_selection.resume.inspect");
      const observed = await execContainer(engine, ["inspect", "-f", "{{.State.Paused}}", id], {
        allowFailure: true,
        signal: AbortSignal.timeout(30_000),
      });
      params.assertCurrent();
      if (observed.code !== 0) {
        if (!/no such (?:container|object)|does not exist/iu.test(observed.stderr)) {
          throw new Error(
            "Local workspace runtime resume inspection failed; exact paused owner retained",
          );
        }
      } else if (observed.stdout.trim() === "true") {
        resumePhases.mark("attempt.setup.sandbox.workspace_selection.resume.authority");
        await runtime.assertCurrent();
        resumePhases.mark("attempt.setup.sandbox.workspace_selection.resume.unpause");
        const result = await execContainer(engine, ["unpause", id], {
          allowFailure: true,
          signal: AbortSignal.timeout(30_000),
        });
        if (
          result.code !== 0 &&
          !/no such (?:container|object)|does not exist/iu.test(result.stderr)
        ) {
          throw new Error("Local workspace runtime resume failed; exact paused owner retained");
        }
      } else if (observed.stdout.trim() !== "false") {
        throw new Error("Invalid local workspace runtime resume inspection");
      }
      params.assertCurrent();
      paused = paused.filter((held) => held.name !== containerName || held.id !== id);
      resumePhases.mark("attempt.setup.sandbox.workspace_selection.resume.persist");
      await params.persist(paused);
    });
  }
  return {
    get retired() {
      return retired;
    },
    retire: async () => {
      params.assertCurrent();
      // Retirement settles persistent writers before acquiring this projection
      // lease. Calling their stop/finalize path here would reacquire the lease.
      for (const { runtime } of selected) {
        if (runtime.kind === "persistent") {
          await runtime.assertRetired();
        }
      }
      params.assertCurrent();
      for (const retire of retirements) {
        await retire();
      }
      params.assertCurrent();
      // Finish receipt cleanup before the caller removes the workspace binding.
      if (paused.length) {
        await params.persist([]);
        paused = [];
      }
      retired = true;
    },
    resume: async () => {
      if (retired) {
        return;
      }
      params.assertCurrent();
      for (const release of releases.toReversed()) {
        await release();
      }
      params.assertCurrent();
      if (paused.length) {
        await params.persist([]);
      }
    },
  };
}
