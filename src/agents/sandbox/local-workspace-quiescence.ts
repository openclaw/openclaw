import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import {
  bindPodmanSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  validateSandboxContainerEngineTarget,
} from "./docker.js";
import {
  readRegistry,
  readBrowserRegistry,
  assertSandboxRegistryEntryCurrent,
  assertSandboxBrowserRegistryEntryCurrent,
} from "./registry.js";

/** Both execution and browser runtimes can write the exact private mount. */
export async function readLocalWorkspaceRuntimes(workspaceDir: string) {
  const [containers, browsers] = await Promise.all([readRegistry(), readBrowserRegistry()]);
  return [
    ...containers.entries
      .filter((entry) => entry.workspaceDir === workspaceDir)
      .map((entry) => ({
        kind: "container" as const,
        entry,
        assertCurrent: () => assertSandboxRegistryEntryCurrent(entry),
      })),
    ...browsers.entries
      .filter((entry) => entry.workspaceDir === workspaceDir)
      .map((entry) => ({
        kind: "browser" as const,
        entry,
        assertCurrent: () => assertSandboxBrowserRegistryEntryCurrent(entry),
      })),
  ];
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
  retained: LocalWorkspacePausedRuntime[];
  persist: (runtimes: LocalWorkspacePausedRuntime[]) => void;
  assertCurrent: () => void;
}) {
  const selected = (await readLocalWorkspaceRuntimes(params.workspaceDir)).map((runtime) => ({
    runtime,
    bridges:
      runtime.kind === "browser"
        ? [...BROWSER_BRIDGES].filter(
            ([, bridge]) => bridge.containerName === runtime.entry.containerName,
          )
        : [],
  }));
  params.assertCurrent();
  let paused = [...params.retained];
  const releases: Array<() => Promise<void>> = [];
  const retirements: Array<() => Promise<void>> = [];
  for (const { runtime, bridges } of selected) {
    const { entry } = runtime;
    const backendId = runtime.kind === "browser" ? "docker" : runtime.entry.backendId;
    const backendTarget = runtime.kind === "container" ? runtime.entry.backendTarget : undefined;
    if (backendId !== "docker" && backendId !== "podman") {
      throw new Error("Local workspace backend cannot fence host projection writes");
    }
    if (backendId === "podman" && !backendTarget) {
      throw new Error("Local workspace Podman engine owner is missing");
    }
    const engine =
      backendId === "podman" ? bindPodmanSandboxEngine(backendTarget!) : DOCKER_SANDBOX_ENGINE;
    // Stopped allocations remain owned resources, but were never live writers.
    const captureRetirement = (id: string | null) =>
      retirements.push(async () => {
        const { removeSandboxRuntimeGeneration } = await import("./manage.js");
        await removeSandboxRuntimeGeneration({
          runtime,
          engine,
          id,
          bridges,
          assertCurrent: () => {
            params.assertCurrent();
            runtime.assertCurrent();
          },
        });
      });
    await validateSandboxContainerEngineTarget(engine, backendTarget);
    params.assertCurrent();
    runtime.assertCurrent();
    const inspect = await execContainer(
      engine,
      ["inspect", "-f", "{{.Id}} {{.State.Running}} {{.State.Paused}}", entry.containerName],
      { allowFailure: true },
    );
    params.assertCurrent();
    if (inspect.code !== 0) {
      if (/no such (?:container|object)|does not exist/iu.test(inspect.stderr)) {
        runtime.assertCurrent();
        captureRetirement(null);
        continue;
      }
      throw new Error("Local workspace runtime could not be inspected; workspace preserved");
    }
    const [id, running, isPaused] = inspect.stdout.trim().split(/\s+/u);
    if (
      !id ||
      !/^[a-f0-9]{64}$/u.test(id) ||
      !["true", "false"].includes(running ?? "") ||
      !["true", "false"].includes(isPaused ?? "")
    ) {
      throw new Error("Invalid local workspace runtime inspection");
    }
    runtime.assertCurrent();
    captureRetirement(id);
    // Podman reports a paused container as Running=false; its exact retained
    // generation still needs recovery and must not be mistaken for a stopped runtime.
    if (running !== "true" && isPaused !== "true") {
      continue;
    }
    const retained = paused.some(
      (retainedRuntime) =>
        retainedRuntime.name === entry.containerName && retainedRuntime.id === id,
    );
    if (isPaused === "true" && !retained) {
      throw new Error(
        "Local workspace runtime was paused by another owner; resume it before retrying",
      );
    }
    if (!retained) {
      paused.push({ name: entry.containerName, id });
      params.persist(paused);
    }
    if (isPaused !== "true") {
      // A retained receipt may outlive an unpause. Re-fence the live writer
      // before reconciliation rather than trusting stale pause metadata.
      params.assertCurrent();
      runtime.assertCurrent();
      await execContainer(engine, ["pause", id]);
    }
    releases.push(async () => {
      await validateSandboxContainerEngineTarget(engine, backendTarget);
      params.assertCurrent();
      // Archive may have removed this exact generation while settlement held it.
      // A missing or already-running runtime needs receipt cleanup, not unpause.
      const observed = await execContainer(engine, ["inspect", "-f", "{{.State.Paused}}", id], {
        allowFailure: true,
      });
      params.assertCurrent();
      if (observed.code !== 0) {
        if (!/no such (?:container|object)|does not exist/iu.test(observed.stderr)) {
          throw new Error(
            "Local workspace runtime resume inspection failed; exact paused owner retained",
          );
        }
      } else if (observed.stdout.trim() === "true") {
        runtime.assertCurrent();
        const result = await execContainer(engine, ["unpause", id], { allowFailure: true });
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
      paused = paused.filter((held) => held.name !== entry.containerName || held.id !== id);
      params.persist(paused);
    });
  }
  return {
    retire: async () => {
      params.assertCurrent();
      for (const retire of retirements) {
        await retire();
      }
      params.assertCurrent();
    },
    resume: async () => {
      params.assertCurrent();
      for (const release of releases.toReversed()) {
        await release();
      }
      params.assertCurrent();
      params.persist([]);
    },
  };
}
