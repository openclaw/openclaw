import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasUnjoinedWork, runManagedCommand } from "../../../scripts/lib/managed-child-process.mts";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareForegroundTestAdmission } from "../run-execution-policy.test-support.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxCleanupEngine,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
  execContainer,
  resolveNativeDockerTarget,
  runNativeSandboxCleanup,
} from "./container-engine.js";
import {
  reconcileForegroundSandboxesAtStartup,
  type NativeSandboxContainerCustody,
} from "./docker-native-custody.js";
import { ensureSandboxContainer } from "./docker.js";
import { acquireForegroundSandboxCustody } from "./foreground-owner.js";
import { resolvePodmanSandboxRuntimeInfo } from "./podman-runtime.js";
import { readRegistryEntry } from "./registry.js";

// Explicit fixture selection prevents ordinary live-provider runs from creating containers.
const engineId = process.env.OPENCLAW_TEST_SANDBOX_ENGINE;
const image = process.env.OPENCLAW_TEST_SANDBOX_IMAGE;
describe.runIf(
  process.platform === "linux" &&
    Boolean(image) &&
    (engineId === "podman" || engineId === "docker"),
)("foreground native runtime", () => {
  it.each(["normal", "stop"] as const)(
    "retires detached descendants on %s and preserves workspace data",
    async (ending) => {
      await withOpenClawTestState({ label: `foreground-live-${ending}` }, async (fixture) => {
        const prepared = prepareForegroundTestAdmission(`foreground-live-${ending}`);
        const context = await prepared.admit("embedded");
        const signal = new AbortController();
        const custody = acquireForegroundSandboxCustody(context, signal.signal);
        const settleOwner = async () => {
          // Only the exact admitted owner may retire this fixture's native allocation.
          try {
            await prepared.close();
          } catch (cause) {
            throw Object.assign(
              new Error(
                "Native fixture cleanup is unconfirmed; retain its workspace and registry for recovery",
                { cause },
              ),
              { processTreeState: "indeterminate" },
            );
          }
        };
        try {
          const selected = captureNativeSandboxEngine(
            engineId === "podman" ? PODMAN_SANDBOX_ENGINE : DOCKER_SANDBOX_ENGINE,
            custody,
          );
          const podman =
            engineId === "podman" ? await resolvePodmanSandboxRuntimeInfo() : undefined;
          if (podman && podman.target.key !== "local") {
            throw new Error("This fixture requires local Linux Podman");
          }
          const engine = bindNativeSandboxEngineTarget(
            selected,
            podman?.target ?? (await resolveNativeDockerTarget(selected)),
          );
          const native: NativeSandboxContainerCustody = { engine, custody };
          const defaults = resolveSandboxConfigForAgent();
          const cfg = {
            ...defaults,
            backend: engine.id,
            workspaceAccess: "rw" as const,
            docker: { ...defaults.docker, image: image! },
          };
          // A proof run must use a qualified pre-existing image; never pull an implicit one.
          await execContainer(engine, ["image", "inspect", image!]);
          const allocated = await custody.runProducer(
            () =>
              ensureSandboxContainer({
                native,
                nativePodmanRuntimeInfo: podman,
                engine,
                podmanTarget: podman?.target,
                scopeKey: "agent:main:fixture",
                workspaceDir: fixture.workspaceDir,
                agentWorkspaceDir: fixture.workspaceDir,
                cfg,
              }),
            { settleAfterAbort: true },
          );
          const child = await execContainer(engine, [
            "exec",
            allocated.containerId,
            "python3",
            "-c",
            "import subprocess; p=subprocess.Popen(['sleep','600'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid)",
          ]);
          const childPid = child.stdout.trim();
          expect(childPid).toMatch(/^\d+$/);
          // The launching command returned, yet the detached descendant is still live.
          await execContainer(engine, [
            "exec",
            allocated.containerId,
            "/bin/sh",
            "-c",
            'kill -0 "$1"',
            "fixture",
            childPid,
          ]);
          const draftPath = path.join(fixture.workspaceDir, "draft.txt");
          await fs.writeFile(draftPath, "retained draft");
          expect(await readRegistryEntry(allocated.containerName)).toMatchObject({
            foreground: { containerId: allocated.containerId },
            runtimeState: "ready",
          });
          if (ending === "stop") {
            signal.abort();
          }
          await prepared.close();
          expect(await readRegistryEntry(allocated.containerName)).toBeNull();
          expect(await fs.readFile(draftPath, "utf8")).toBe("retained draft");
          await runNativeSandboxCleanup(engine, async (exec) => {
            const inspection = await exec(["inspect", allocated.containerId], true);
            expect(inspection.code).not.toBe(0);
            expect(inspection.stderr.toString("utf8")).toMatch(/no such|does not exist/i);
          });
        } finally {
          await settleOwner();
        }
      });
    },
    120_000,
  );

  it("reconciles a crashed owner's real allocation at startup and retains its draft", async () => {
    await withOpenClawTestState({ label: "foreground-live-crash" }, async (fixture) => {
      const draftPath = path.join(fixture.workspaceDir, "draft.txt");
      await fs.writeFile(draftPath, "retained draft");
      const readyPrefix = "foreground-crash-ready:";
      const moduleUrl = (relative: string) =>
        JSON.stringify(new URL(relative, import.meta.url).href);
      const script = `
        import { writeSync } from "node:fs";
        import { prepareForegroundTestAdmission } from ${moduleUrl("../run-execution-policy.test-support.ts")};
        import { resolveSandboxConfigForAgent } from ${moduleUrl("./config.ts")};
        import { bindNativeSandboxEngineTarget, captureNativeSandboxEngine, DOCKER_SANDBOX_ENGINE,
          PODMAN_SANDBOX_ENGINE, execContainer, resolveNativeDockerTarget } from ${moduleUrl("./container-engine.ts")};
        import { ensureSandboxContainer } from ${moduleUrl("./docker.ts")};
        import { acquireForegroundSandboxCustody } from ${moduleUrl("./foreground-owner.ts")};
        import { resolvePodmanSandboxRuntimeInfo } from ${moduleUrl("./podman-runtime.ts")};
        const prepared = prepareForegroundTestAdmission("foreground-live-crash");
        try {
          const context = await prepared.admit("embedded");
          const custody = acquireForegroundSandboxCustody(context);
          const engineId = ${JSON.stringify(engineId)};
          const image = ${JSON.stringify(image)};
          const workspaceDir = ${JSON.stringify(fixture.workspaceDir)};
          const selected = captureNativeSandboxEngine(
            engineId === "podman" ? PODMAN_SANDBOX_ENGINE : DOCKER_SANDBOX_ENGINE, custody);
          const podman = engineId === "podman" ? await resolvePodmanSandboxRuntimeInfo() : undefined;
          if (podman && podman.target.key !== "local") throw new Error("This fixture requires local Linux Podman");
          const engine = bindNativeSandboxEngineTarget(selected,
            podman?.target ?? await resolveNativeDockerTarget(selected));
          const defaults = resolveSandboxConfigForAgent();
          await execContainer(engine, ["image", "inspect", image]);
          const allocated = await custody.runProducer(() => ensureSandboxContainer({
            native: { engine, custody }, nativePodmanRuntimeInfo: podman, engine,
            podmanTarget: podman?.target, scopeKey: "agent:main:crash-fixture",
            workspaceDir, agentWorkspaceDir: workspaceDir,
            cfg: { ...defaults, backend: engine.id, workspaceAccess: "rw",
              docker: { ...defaults.docker, image } },
          }), { settleAfterAbort: true });
          const child = await execContainer(engine, ["exec", allocated.containerId, "python3", "-c",
            "import subprocess; p=subprocess.Popen(['sleep','600'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid)"]);
          const childPid = child.stdout.trim();
          if (!/^\\d+$/.test(childPid)) throw new Error("Detached fixture child did not return a PID");
          await execContainer(engine, ["exec", allocated.containerId, "/bin/sh", "-c", 'kill -0 "$1"', "fixture", childPid]);
          writeSync(1, ${JSON.stringify(readyPrefix)} + JSON.stringify({
            containerId: allocated.containerId, containerName: allocated.containerName,
            runId: context.operationalRunInstance.runId,
            instanceId: context.operationalRunInstance.instanceId,
          }) + "\\n");
          // SIGKILL leaves the production allocation lock and SQLite receipt behind.
          process.kill(process.pid, "SIGKILL");
        } finally {
          await prepared.close();
        }
      `;
      let childJoined = false;
      let childFailure: unknown;
      let reconciliationStarted = false;
      const reconcile = async () => {
        reconciliationStarted = true;
        try {
          const failures = await reconcileForegroundSandboxesAtStartup();
          if (failures.length > 0) {
            throw new AggregateError(failures, "Startup could not retire the crashed allocation");
          }
        } catch (cause) {
          throw Object.assign(
            new Error(
              "Native crash fixture cleanup is unconfirmed; retain its workspace and registry",
              {
                cause,
              },
            ),
            { processTreeState: "indeterminate" },
          );
        }
      };
      const settleCrash = async () => {
        if (!childJoined) {
          throw Object.assign(
            new Error(
              "Crash fixture child cleanup is unconfirmed; retain its workspace and registry",
              {
                cause: childFailure,
              },
            ),
            { processTreeState: "indeterminate" },
          );
        }
        if (!reconciliationStarted) {
          await reconcile();
        }
      };
      try {
        let stdout = "";
        let stderr = "";
        const status = await runManagedCommand({
          bin: process.execPath,
          args: [
            "--import",
            fileURLToPath(new URL("../../../scripts/tsx.mjs", import.meta.url)),
            "--input-type=module",
            "--eval",
            script,
          ],
          env: {
            ...fixture.env,
            TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
          },
          stdio: ["ignore", "pipe", "pipe"],
          requireProcessTreeExit: true,
          timeoutMs: 60_000,
          onReady(child) {
            child.stdout?.on("data", (chunk) => {
              stdout = (stdout + chunk.toString()).slice(-8192);
            });
            child.stderr?.on("data", (chunk) => {
              stderr = (stderr + chunk.toString()).slice(-8192);
            });
          },
        }).catch((error: unknown) => {
          childJoined = !hasUnjoinedWork(error);
          childFailure = error;
          throw error;
        });
        childJoined = true;
        expect(status, stderr).toBe(137);
        const ready = stdout.split("\n").find((line) => line.startsWith(readyPrefix));
        expect(ready, stderr).toBeDefined();
        const allocated = JSON.parse(ready!.slice(readyPrefix.length)) as {
          containerId: string;
          containerName: string;
          runId: string;
          instanceId: string;
        };
        expect(allocated.containerId).toMatch(/^[a-f0-9]{64}$/);
        const receipt = await readRegistryEntry(allocated.containerName);
        expect(receipt).toMatchObject({
          runtimeState: "ready",
          workspaceDir: fixture.workspaceDir,
          foreground: {
            containerId: allocated.containerId,
            runId: allocated.runId,
            instanceId: allocated.instanceId,
            createAttempted: true,
            startAttempted: true,
          },
        });
        if (!receipt?.backendTarget) {
          throw new Error("Crashed allocation lost its engine target");
        }
        const engine = bindNativeSandboxEngineTarget(
          captureNativeSandboxCleanupEngine(
            engineId === "podman" ? PODMAN_SANDBOX_ENGINE : DOCKER_SANDBOX_ENGINE,
          ),
          receipt.backendTarget,
        );
        // A dead Gateway cannot promise immediate extinction; startup owns this retirement.
        await runNativeSandboxCleanup(engine, async (exec) => {
          const inspection = await exec([
            "inspect",
            "--format",
            "{{.Id}} {{.State.Running}}",
            allocated.containerId,
          ]);
          expect(inspection.stdout.toString("utf8").trim()).toBe(`${allocated.containerId} true`);
        });
        await reconcile();
        expect(await readRegistryEntry(allocated.containerName)).toBeNull();
        expect(await fs.readFile(draftPath, "utf8")).toBe("retained draft");
        await runNativeSandboxCleanup(engine, async (exec) => {
          const inspection = await exec(["inspect", allocated.containerId], true);
          expect(inspection.code).not.toBe(0);
          expect(inspection.stderr.toString("utf8")).toMatch(/no such|does not exist/i);
        });
      } finally {
        await settleCrash();
      }
    });
  }, 120_000);
});
