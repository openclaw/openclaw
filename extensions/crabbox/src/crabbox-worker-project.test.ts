import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { destroyAndWait, commandResult } from "./crabbox-worker-provider.test-support.js";
import { CrabboxCheckpointCreateError } from "./crabbox-worker-warm-image-checkpoint.js";
import {
  listCrabboxWarmImages,
  recoverCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-store.js";
import {
  CHECKPOINT_ID,
  PROJECT_KEY,
  BASE_COMMIT,
  createProjectOptions as projectOptions,
  CLASSLESS_PROFILE,
  PROFILE,
  checkpointResult,
  createWarmProvider,
  tempDirs,
  unsupportedCaptureReceipt,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

const warmImage = async () => (await listCrabboxWarmImages(crabboxState))[0];
const commandCount = (calls: CommandCall[], command: string) =>
  calls.filter(({ argv }) => argv[1] === command || argv[2] === command).length;
const PREPARATION_EVENTS = ["project-prepared", "runtime-granted", "runtime-install", "capture"];
const ENROLLMENT_EVENTS = ["enrollment-begun", "enrollment-install"];
const runtimeGrant = (signal: AbortSignal) => ({
  nodeBootstrap: createNodeBootstrapFixture(),
  workerBundle: createWorkerArchiveFixture(),
  signal,
});

function projectFixture(
  command?: Parameters<typeof createWarmProvider>[0],
  controller?: AbortController,
) {
  const leaseId = operationLeaseId("project");
  const events: string[] = [];
  const { options, observe } = projectOptions(events, controller);
  const warm = createWarmProvider((call) => {
    observe(call);
    return command?.(call);
  });
  return {
    ...warm,
    leaseId,
    options,
    events,
    provision: (overrides: Partial<ProvisionOptions> = {}, profile = PROFILE) =>
      warm.provider.provision(profile, "project", { ...options, ...overrides }),
    count: (name: string) => commandCount(warm.calls, name),
    allocation: async () => (await warmImage())?.allocations[leaseId],
  };
}

function writeFile(file: string, content: string | Buffer, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

async function expectNoCapture() {
  expect((await listCrabboxWarmImages(crabboxState)).every((image) => !image.capture)).toBe(true);
}

type ProvisionOptions = NonNullable<Parameters<WorkerProvider["provision"]>[2]>;

function notSubmittedReceipt(leaseId: string) {
  return {
    schema: "crabbox.checkpoint.create.failure.v1",
    outcome: "not_submitted",
    provider: "aws",
    leaseId,
    checkpointId: "chk_not_submitted",
    localReservation: "removed",
  };
}

describe("Crabbox project snapshot provisioning", () => {
  it("skips refused native captures across restart until the refresh interval expires", async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const events: string[] = [];
    let current = projectOptions(events);
    let unsupported = true;
    const profile = { ...CLASSLESS_PROFILE, provider: "hetzner", class: "standard" };
    const command = (call: CommandCall) => {
      current.observe(call);
      if (unsupported && call.argv[2] === "create") {
        return commandResult({
          code: 2,
          stdout: JSON.stringify(
            unsupportedCaptureReceipt(call.argv[call.argv.indexOf("--id") + 1]!, "hetzner"),
          ),
          stderr: "checkpoint mode must be auto, native, or archive",
        });
      }
      return undefined;
    };
    const { provider, calls, warn, stateDir } = createWarmProvider(command);
    const source = await provider.provision(profile, "unsupported-project", current.options);
    expect(events).toEqual([...PREPARATION_EVENTS, ...ENROLLMENT_EVENTS]);
    expect(commandCount(calls, "stop")).toBe(0);
    expect(await warmImage()).toMatchObject({
      captureUnsupported: {
        atMs: now,
        provider: "hetzner",
        message: unsupportedCaptureReceipt("unused").message,
      },
      allocations: { [source.leaseId]: { phase: "enrolled", choice: { kind: "cold" } } },
    });
    expect((await warmImage())?.capture).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Crabbox warm image capture unsupported:"),
    );
    await destroyAndWait(provider, { ...source, profile });
    expect((await warmImage())?.captureUnsupported?.atMs).toBe(now);
    await provider.dispose();
    const restarted = createWarmProvider(command, stateDir);
    clock.mockReturnValue(now + 60_000);
    current = projectOptions([]);
    const next = await restarted.provider.provision(profile, "refused-next", current.options);
    expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
    expect(current.options.beginNodeEnrollment).toHaveBeenCalledOnce();
    expect(commandCount(restarted.calls, "create")).toBe(0);
    await destroyAndWait(restarted.provider, { ...next, profile });
    expect(commandCount(restarted.calls, "create")).toBe(0);
    clock.mockReturnValue(now + 86_400_000);
    unsupported = false;
    current = projectOptions([]);
    await restarted.provider.provision(profile, "supported-next", current.options);
    expect(current.options.prepareNodeRuntime).toHaveBeenCalledOnce();
    expect(commandCount(restarted.calls, "create")).toBe(1);
    const image = await warmImage();
    expect(image?.checkpointId).toBe(CHECKPOINT_ID);
    expect(image?.captureUnsupported).toBeUndefined();
  });

  it.skipIf(process.platform === "win32").each(["none", "runtime", "scrub"] as const)(
    "prepares and scrubs in one settled command before capture (failure=%s)",
    async (failure) => {
      const home = fs.realpathSync(tempDirs.make("openclaw-crabbox-capture-command-"));
      const f = projectFixture((call) => {
        if (call.argv[2] === "create") {
          filesAtCapture = privateFiles.map((file) => fs.existsSync(file));
          archiveAtCapture = fs.readFileSync(retainedArchive);
        }
        if (
          call.argv[1] !== "run" ||
          call.options.input === "project-checkout" ||
          f.events.includes("enrollment-begun")
        ) {
          return undefined;
        }
        preparationCommands += 1;
        const scriptPath = privateFiles[3]!;
        writeFile(scriptPath, String(call.options.input));
        const result = spawnSync("/bin/sh", [scriptPath], {
          cwd: home,
          env: {
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            CRABBOX_TEST_NODE: resolveTestNodeExecPath(),
            ...(call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")
              ? {
                  CRABBOX_WORKER_BOOTSTRAP_TOKEN: JSON.stringify({
                    nodeBootstrap: nodeBootstrap.token,
                    workerBundle: workerBundle.token,
                  }),
                }
              : {}),
          },
          encoding: "utf8",
          timeout: 5_000,
        });
        preparationProcess = result;
        return commandResult({ code: result.status, stdout: result.stdout, stderr: result.stderr });
      });
      const { options } = f;
      const nodeBootstrap = createNodeBootstrapFixture();
      const archive = Buffer.from("verified synthetic worker archive");
      const archiveSha = createHash("sha256").update(archive).digest("hex");
      const workerBundle = {
        ...createWorkerArchiveFixture(),
        sha256: archiveSha,
        bytes: archive.length,
        packageRelativePath: `worker-artifacts/${archiveSha}.tgz`,
      };
      options.nodeRuntimeIdentity.workerBundleSha256 = archiveSha;
      options.prepareNodeRuntime.mockResolvedValue({
        nodeBootstrap,
        workerBundle,
        signal: options.project.signal,
      });
      const packageRoot = path.join(
        home,
        ".openclaw-worker/node-runtimes",
        nodeBootstrap.sha256,
        "node_modules/openclaw",
      );
      const retainedArchive = path.join(packageRoot, workerBundle.packageRelativePath);
      const privateFiles = [
        ".openclaw/cloud-workers/previous-worker/setup-code",
        ".openclaw-worker/workspaces/previous-session/private.txt",
        ".crabbox/env/forwarded.env",
        ".crabbox/scripts/prepare.sh",
      ].map((relative) => path.join(home, relative));
      for (const file of privateFiles) {
        writeFile(file, "synthetic private state");
      }
      writeFile(retainedArchive, archive);
      writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: failure === "runtime" ? "0.0.0" : "2026.8.1" }),
      );
      writeFile(
        path.join(packageRoot, "openclaw.mjs"),
        `import fs from "node:fs";
import path from "node:path";
if (process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN || !fs.existsSync(${JSON.stringify(privateFiles[0])})) process.exit(9);
fs.writeFileSync(path.join(process.env.HOME, "runtime-verified"), "verified");
console.log("OpenClaw 2026.8.1");
`,
      );
      const bin = path.join(home, "bin");
      writeFile(
        path.join(bin, "node"),
        `#!/bin/sh
set -eu
if [ -f "$HOME/runtime-verified" ] && [ -n "\${CRABBOX_WORKER_BOOTSTRAP_TOKEN-}" ]; then
  echo "bootstrap credentials reached scrub" >&2
  exit 9
fi
exec "$CRABBOX_TEST_NODE" "$@"
`,
        0o700,
      );
      if (failure === "scrub") {
        writeFile(
          path.join(bin, "rm"),
          '#!/bin/sh\ncase "$*" in *".crabbox/env"*) exit 7;; esac\nexec /bin/rm "$@"\n',
          0o700,
        );
      }
      let preparationCommands = 0;
      let preparationProcess: { error?: Error; signal: NodeJS.Signals | null } | undefined;
      let filesAtCapture: boolean[] | undefined;
      let archiveAtCapture: Buffer | undefined;

      const provision = f.provision();
      await provision.catch(() => {});
      expect(preparationProcess?.error).toBeUndefined();
      expect(preparationProcess?.signal).toBeNull();
      if (failure === "none") {
        await expect(provision).resolves.toMatchObject({ node: { deviceId: "project-node" } });
        expect(filesAtCapture).toEqual([false, false, false, false]);
        expect(archiveAtCapture).toEqual(archive);
        expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      } else {
        await expect(provision).rejects.toThrow();
        expect(filesAtCapture).toBeUndefined();
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
        expect(f.count("stop")).toBe(1);
        expect(fs.existsSync(privateFiles[2]!)).toBe(true);
      }
      expect(preparationCommands).toBe(1);
      expect(fs.existsSync(path.join(home, "runtime-verified"))).toBe(failure !== "runtime");
      await expectNoCapture();
    },
  );

  it("reports checkpoint rejection and cleanup failure while retaining capture recovery", async () => {
    const diagnostic =
      'coordinator POST /v1/checkpoints: http 429: {"error":"checkpoint_limit_exceeded","message":"checkpoint admission limit exceeded: scope=owner observed=10 limit=10"}';
    let blocked = true;
    const f = projectFixture(({ argv }) => {
      if (blocked && argv[2] === "create") {
        return commandResult({ code: 5, stderr: diagnostic });
      }
      if (blocked && argv[1] === "stop") {
        return commandResult({ code: 2, stderr: "source has unresolved checkpoint chk_quota" });
      }
      return undefined;
    });
    const { options, provider, calls, warn } = f;

    const failure = await f.provision().catch((error: unknown) => error);
    const message = formatErrorMessage(failure);
    expect(message).toContain(diagnostic);
    expect(message).toContain("capture is unresolved");
    const capture = (await warmImage())?.capture;
    expect(capture).toMatchObject({ phase: "uncertain" });
    expect(message).toContain(`--recover ${capture!.selector}`);
    expect(message).toContain("source has unresolved checkpoint chk_quota");
    expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
    expect(commandCount(calls, "stop")).toBe(1);

    const lease = { leaseId: f.leaseId, profile: PROFILE };
    warn.mockClear();
    for (let retry = 0; retry < 3; retry++) {
      await expect(provider.destroy(lease)).rejects.toThrow("source has unresolved checkpoint");
    }
    expect([commandCount(calls, "create"), commandCount(calls, "stop")]).toEqual([1, 4]);
    expect(warn.mock.calls.filter(([warning]) => warning.includes("capture paused"))).toEqual([
      [expect.stringContaining(`--recover ${capture!.selector} --acknowledge-provider-cleanup`)],
    ]);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("warm image capture failed for lease"),
    );
    expect((await warmImage())?.capture).toEqual(capture);

    // Operator recovery closes the persisted claim; the next eligible teardown can capture.
    blocked = false;
    await recoverCrabboxWarmImageCapture(crabboxState, capture!.selector, true);
    await destroyAndWait(provider, lease);
    expect(commandCount(calls, "create")).toBe(2);
    expect((await warmImage())?.capture).toBeUndefined();
  });

  it.each([
    { replaced: false, unsupported: false },
    { replaced: true, unsupported: false },
    { replaced: true, unsupported: true },
  ])(
    "clears only its own rejected capture and still stops the source (replaced=$replaced, unsupported=$unsupported)",
    async ({ replaced, unsupported }) => {
      const f = projectFixture((call) => {
        if (call.argv[2] !== "create") {
          return undefined;
        }
        if (replaced) {
          const store = openWarmImageStore();
          const entry = store.entries()[0]!;
          store.register(entry.key, {
            ...entry.value,
            operation: {
              type: "capture",
              id: "replacement-capture",
              leaseId: "cbx_replacement",
              provider: "aws",
              startedAtMs: Date.now(),
              phase: "creating",
            },
          });
        }
        return commandResult({
          code: 2,
          stdout: JSON.stringify(
            unsupported ? unsupportedCaptureReceipt(f.leaseId) : notSubmittedReceipt(f.leaseId),
          ),
          stderr: "image submission rejected; source rollback failed",
        });
      });

      await expect(f.provision()).rejects.toThrow(
        "image submission rejected; source rollback failed",
      );
      expect(f.options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(f.count("stop")).toBe(1);
      expect(f.calls.find(({ argv }) => argv[1] === "stop")?.argv).toContain(f.leaseId);
      if (replaced) {
        expect((await warmImage())?.captureUnsupported).toBeUndefined();
        expect((await warmImage())?.capture).toMatchObject({
          selector: "replacement-capture",
          leaseId: "cbx_replacement",
          phase: "creating",
        });
        expect(await f.allocation()).toBeUndefined();
      } else {
        expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
      }
    },
  );

  it.each([
    { crash: "pending", alreadyComplete: false, replayCaptures: 1 },
    { crash: "prepared", alreadyComplete: false, replayCaptures: 1 },
    { crash: "published", alreadyComplete: false, replayCaptures: 0 },
    { crash: "pending", alreadyComplete: true, replayCaptures: 1 },
    { crash: "none", alreadyComplete: true, replayCaptures: 0 },
  ])(
    "preserves reserve capture on $crash replay (image complete=$alreadyComplete)",
    async ({ crash, alreadyComplete, replayCaptures }) => {
      const preparation = {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "reserve" as const,
        demandAtMs: Date.now(),
      };
      let captures = 0;
      const command = ({ argv }: CommandCall) =>
        argv[2] === "create"
          ? checkpointResult(
              `${CHECKPOINT_ID}_${++captures}`,
              argv[argv.indexOf("--id") + 1]!,
              "completed",
            )
          : undefined;
      const initial = createWarmProvider(command);
      const baseline = await initial.provider.provision(
        PROFILE,
        "replay-baseline",
        projectOptions([], undefined, preparation).options,
      );
      await destroyAndWait(initial.provider, { ...baseline, profile: PROFILE });
      await initial.provider.dispose();
      const operation = "prepared-capture-replay";
      const leaseId = operationLeaseId(operation);
      let completionPublished = alreadyComplete;
      const optionsFor = (interrupt: boolean) => {
        const controller = new AbortController();
        const { options } = projectOptions([], controller);
        const prepare = options.project.prepare;
        const project: NonNullable<ProvisionOptions["project"]> = {
          ...options.project,
          preparation,
          inspectPreparedWorkspace: vi.fn(async () => {}),
          prepare: vi.fn<NonNullable<ProvisionOptions["project"]>["prepare"]>(async (transport) => {
            const result = await prepare(transport);
            const captureRequired: true | undefined = completionPublished ? undefined : true;
            completionPublished = true;
            if (interrupt && crash === "pending") {
              controller.abort();
            }
            return { ...result, captureRequired };
          }),
          assertCurrent: () => {
            if (
              interrupt &&
              crash === "prepared" &&
              openWarmImageStore().entries()[0]?.value.allocations[leaseId]?.phase === "prepared"
            ) {
              controller.abort();
            }
            controller.signal.throwIfAborted();
          },
        };
        const begin = options.beginNodeEnrollment;
        return {
          ...options,
          project,
          beginNodeEnrollment: vi.fn(async () => {
            if (interrupt && crash === "published") {
              controller.abort();
              controller.signal.throwIfAborted();
            }
            return await begin();
          }),
        };
      };
      const first = createWarmProvider(command, initial.stateDir);
      if (crash === "none") {
        await first.provider.provision(PROFILE, operation, optionsFor(false));
        expect(captures).toBe(1);
      } else {
        await expect(
          first.provider.provision(PROFILE, operation, optionsFor(true)),
        ).rejects.toThrow();
        expect((await warmImage())?.allocations[leaseId]?.phase).toBe(
          crash === "pending" ? "pending" : "prepared",
        );
        expect((await warmImage())?.capture).toBeUndefined();
      }
      await first.provider.dispose();
      const before = captures;
      const resumed = createWarmProvider(command, initial.stateDir);
      await resumed.provider.provision(PROFILE, operation, optionsFor(false));
      expect(captures - before).toBe(replayCaptures);
      const enrolled = optionsFor(false);
      await resumed.provider.provision(PROFILE, operation, enrolled);
      expect(enrolled.project.prepare).not.toHaveBeenCalled();
      expect(enrolled.prepareNodeRuntime).not.toHaveBeenCalled();
      expect(enrolled.project.inspectPreparedWorkspace).toHaveBeenCalledOnce();
      expect(captures - before).toBe(replayCaptures);
    },
  );

  it("waits beyond the submission deadline for a retained checkpoint before enrollment", async () => {
    const entered = createDeferred<void>();
    const available = createDeferred<void>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = projectFixture(async (call) => {
      if (call.argv[2] !== "create") {
        return undefined;
      }
      entered.resolve();
      // Crabbox only continues an admitted checkpoint_pending response when wait is enabled.
      if (call.argv.includes("--wait=false")) {
        return commandResult({ code: 1, stderr: "http 503: checkpoint_pending" });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          available.promise.then(() => checkpointResult(CHECKPOINT_ID, f.leaseId, "available")),
          new Promise<ReturnType<typeof commandResult>>((resolve) => {
            timer = setTimeout(
              () => resolve(commandResult({ code: null, killed: true, termination: "timeout" })),
              call.options.timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    const { options, provider, calls } = f;
    const provision = f.provision().then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );
    try {
      await entered.promise;
      // A provider can still be preparing its snapshot after the old 3m submission cap.
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      available.resolve();
      await expect(provision).resolves.toMatchObject({
        lease: { node: { deviceId: "project-node" } },
      });
      const capture = calls.find(({ argv }) => argv[2] === "create")!;
      expect(capture.argv).toEqual(
        expect.arrayContaining(["--wait", "--wait-timeout", "2700000ms"]),
      );
      expect(provider.resolveProvisionTimeoutMs?.(PROFILE)).toBeGreaterThan(
        calls.reduce((total, call) => total + call.options.timeoutMs, 0),
      );
    } finally {
      available.resolve();
      await provision;
      vi.useRealTimers();
    }
    expect(await warmImage()).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      state: "available",
      allocations: { [f.leaseId]: { phase: "enrolled" } },
    });
    expect(commandCount(calls, "create")).toBe(1);
    expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
    expect((await warmImage())?.capture).toBeUndefined();
  });

  it.each(["project transfer", "runtime grant", "runtime setup", "enrollment setup"] as const)(
    "cancels explicit Stop during %s without replacing its narrower grant signal",
    async (phase) => {
      const controller = new AbortController();
      const reason = new DOMException("Stop snapshot provisioning", "AbortError");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let commandSignal: AbortSignal | undefined;
      const f = projectFixture(async (call) => {
        const input = call.options.input?.toString();
        const currentPhase =
          input === "project-checkout"
            ? "project transfer"
            : call.argv[1] === "run" && call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")
              ? f.events.includes("enrollment-begun")
                ? "enrollment setup"
                : "runtime setup"
              : undefined;
        if (currentPhase !== phase) {
          return undefined;
        }
        commandSignal = call.options.signal;
        entered.resolve();
        await release.promise;
        return commandResult({ code: 7, stderr: "command interrupted" });
      });
      const { options, calls } = f;
      if (phase === "runtime grant") {
        options.prepareNodeRuntime.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return runtimeGrant(options.project.signal);
        });
      }
      let settled = false;
      const operation = f
        .provision({ signal: controller.signal })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await entered.promise;
      const initialCommandCount = calls.length;
      try {
        controller.abort(reason);
        await setImmediate();
        expect(options.project.signal.aborted).toBe(false);
        if (phase !== "runtime grant") {
          expect(commandSignal?.aborted).toBe(true);
        }
        expect(settled).toBe(false);
        expect(calls).toHaveLength(initialCommandCount);
      } finally {
        release.resolve();
        await operation;
      }
      expect(await operation).toBe(reason);
      expect(calls).toHaveLength(initialCommandCount);
      if (phase !== "enrollment setup") {
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      }
      expect(commandCount(calls, "stop")).toBe(0);
    },
  );

  it.each([
    { backend: "aws", desktop: true },
    { backend: "daytona", desktop: false },
    { backend: "machine0", desktop: false },
  ])(
    "captures the prepared $backend project before enrollment and reuses it (desktop=$desktop)",
    async ({ backend, desktop }) => {
      const profile = { ...PROFILE, provider: backend, desktop };
      const events: string[] = [];
      let current = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => {
        if (
          call.argv[1] === "run" &&
          String(call.options.input).includes("openclaw-worker-browser")
        ) {
          events.push("desktop");
        }
        current.observe(call);
        if (
          backend === "daytona" &&
          call.argv[2] === "create" &&
          !call.argv.includes("--no-reboot=false")
        ) {
          return commandResult({
            code: 2,
            stderr:
              "Daytona filesystem snapshots require a stopped source; rerun with --no-reboot=false",
          });
        }
        return undefined;
      });

      await provider.provision(profile, "project-first", current.options);

      expect(events).toEqual([
        ...(desktop ? ["desktop"] : []),
        ...PREPARATION_EVENTS,
        ...ENROLLMENT_EVENTS,
      ]);
      expect(await warmImage()).toMatchObject({
        projectKey: PROJECT_KEY,
        checkpointId: CHECKPOINT_ID,
        allocations: {
          [operationLeaseId("project-first")]: { phase: "enrolled", baseCommit: BASE_COMMIT },
        },
      });
      calls.length = 0;
      events.length = 0;
      current = projectOptions(events);
      await provider.provision(profile, "project-second", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
      expect([commandCount(calls, "warmup"), commandCount(calls, "create")]).toEqual([0, 0]);
      expect(calls.filter(({ argv }) => argv[2] === "inspect")).toHaveLength(0);
      expect(events).toEqual([
        ...(desktop ? ["desktop"] : []),
        "project-prepared",
        ...ENROLLMENT_EVENTS,
      ]);
      expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
      // A cache hit does not restart the machine; only allocation needs provider readiness.
      expect(
        calls.filter(({ argv }) => argv[1] === "inspect" || argv[1] === "status"),
      ).toHaveLength(1);
    },
  );

  it.each(["grant", "readiness"] as const)(
    "preserves preparation %s failure ownership without enrollment",
    async (failure) => {
      let captured = false;
      const f = projectFixture((call) => {
        captured ||= call.argv[2] === "create";
        if (captured && failure === "readiness" && call.argv[1] === "inspect") {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });
      const { options } = f;
      if (failure === "grant") {
        options.prepareNodeRuntime.mockRejectedValueOnce(new Error("runtime grant failed"));
      }
      await expect(f.provision()).rejects.toThrow();
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(f.count("create") > 0).toBe(failure === "readiness");
      expect(f.count("stop")).toBe(failure === "readiness" ? 0 : 1);
      await expectNoCapture();
      if (failure === "readiness") {
        expect(await f.allocation()).toMatchObject({ phase: "prepared", choice: { kind: "cold" } });
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "fences a runtime grant that will %s after project ownership changes",
    async (outcome) => {
      const controller = new AbortController();
      const f = projectFixture(undefined, controller);
      const { options, events } = f;
      let current = true;
      const closed = new DOMException("Project owner changed", "AbortError");
      options.project.assertCurrent = () => {
        if (!current) {
          controller.abort(closed);
        }
        controller.signal.throwIfAborted();
      };
      options.prepareNodeRuntime.mockImplementationOnce(async () => {
        current = false;
        expect(controller.signal.aborted).toBe(false);
        if (outcome === "reject") {
          throw closed;
        }
        return runtimeGrant(new AbortController().signal);
      });

      await expect(f.provision()).rejects.toMatchObject({ name: "AbortError" });

      expect(events).not.toContain("runtime-install");
      expect([f.count("stop"), f.count("create")]).toEqual([0, 0]);
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(await f.allocation()).toMatchObject({ phase: "prepared", choice: { kind: "cold" } });
      expect((await warmImage())?.capture).toBeUndefined();
    },
  );

  it.each<{
    failure: string;
    result?: Partial<SpawnResult>;
    receipt?: Partial<ReturnType<typeof notSubmittedReceipt>>;
  }>([
    { failure: "aborted" },
    { failure: "response lost", result: { stdout: "" } },
    { failure: "retained reservation", receipt: { localReservation: "retained" } },
    { failure: "unknown schema", receipt: { schema: "crabbox.checkpoint.create.failure.v2" } },
  ])(
    "retains uncertainty and prevents enrollment after native capture: $failure",
    async ({ failure, result, receipt }) => {
      const controller = new AbortController();
      const f = projectFixture((call) => {
        if (call.argv[2] !== "create") {
          return undefined;
        }
        if (failure === "aborted") {
          controller.abort();
        }
        expect(call.options.signal).toBe(controller.signal);
        return commandResult({
          code: 7,
          stderr: "capture failed",
          stdout: JSON.stringify({
            ...notSubmittedReceipt(f.leaseId),
            ...receipt,
          }),
          ...result,
        });
      }, controller);

      await expect(f.provision()).rejects.toThrow();

      expect(f.events).toContain("capture");
      expect(f.options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(f.events).not.toContain("enrollment-install");
      expect((await warmImage())?.capture?.phase).toBe("uncertain");
      expect(f.count("stop") > 0).toBe(failure !== "aborted");
    },
  );

  it.each<{
    failure: string;
    result?: Partial<SpawnResult>;
    receipt?: Record<string, unknown>;
  }>([
    { failure: "extra key", receipt: { extra: true } },
    { failure: "wrong reason", receipt: { reason: "quota" } },
    { failure: "wrong reservation", receipt: { localReservation: "removed" } },
    { failure: "wrong provider", receipt: { provider: "hetzner" } },
    { failure: "empty message", receipt: { message: "" } },
    { failure: "oversized message", receipt: { message: "x".repeat(1025) } },
    { failure: "non-string message", receipt: { message: 42 } },
    { failure: "unknown schema", receipt: { schema: "unknown" } },
    { failure: "wrong outcome", receipt: { outcome: "submitted" } },
    { failure: "timeout", result: { termination: "timeout" } },
    { failure: "null exit", result: { code: null } },
    { failure: "killed", result: { killed: true } },
    { failure: "signal", result: { signal: "SIGTERM" } },
    { failure: "stdout truncation", result: { stdoutTruncatedBytes: 1 } },
    { failure: "stderr truncation", result: { stderrTruncatedBytes: 1 } },
    { failure: "output limit", result: { outputLimitExceeded: true } },
    { failure: "error stream", result: { outputErrorStream: "stdout" } },
    { failure: "cleanup", result: { cleanup: "uncertain" } },
    { failure: "multiple JSON objects", result: { stdout: "{}\n{}" } },
    {
      failure: "oversized stdout",
      result: {
        stdout:
          JSON.stringify(
            unsupportedCaptureReceipt(operationLeaseId("unsupported-oversized stdout")),
          ) + " ".repeat(4097),
      },
    },
  ])("rejects an unsupported capture receipt for $failure", ({ failure, result, receipt }) => {
    const context = { provider: "aws", id: operationLeaseId(`unsupported-${failure}`) };
    const error = new CrabboxCheckpointCreateError(
      commandResult({
        code: 2,
        stdout: JSON.stringify({ ...unsupportedCaptureReceipt(context.id), ...receipt }),
        stderr: "checkpoint mode must be auto, native, or archive",
        ...result,
      }),
    );
    expect(CrabboxCheckpointCreateError.unsupportedCapture(error, context)).toBeUndefined();
  });

  it("keeps an unsupported refusal for a different lease uncertain before enrollment", async () => {
    const f = projectFixture(({ argv }) =>
      argv[2] === "create"
        ? commandResult({
            code: 2,
            stdout: JSON.stringify(unsupportedCaptureReceipt("cbx_other")),
          })
        : undefined,
    );
    await expect(f.provision()).rejects.toThrow("capture is unresolved");
    expect(f.options.beginNodeEnrollment).not.toHaveBeenCalled();
    const image = await warmImage();
    expect(image?.capture?.phase).toBe("uncertain");
    expect(image?.captureUnsupported).toBeUndefined();
  });

  it.each([false, true])(
    "preserves capture uncertainty but reports the source cleanup result after cancellation (stopFails=%s)",
    async (stopFails) => {
      const controller = new AbortController();
      const f = projectFixture(({ argv }) => {
        if (argv[2] === "create") {
          controller.abort();
          return commandResult({ code: 2, stderr: "capture interrupted" });
        }
        if (argv[1] === "stop" && stopFails) {
          return commandResult({ code: 5, stderr: "source cleanup still pending" });
        }
        return undefined;
      }, controller);
      const leaseId = f.leaseId;
      const { options, provider, calls, warn } = f;

      await expect(f.provision()).rejects.toMatchObject({ name: "AbortError" });
      const capture = (await warmImage())?.capture;
      expect(capture).toMatchObject({ leaseId, phase: "uncertain" });
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(commandCount(calls, "stop")).toBe(0);
      calls.length = 0;
      warn.mockClear();

      const cleanup = destroyAndWait(provider, { leaseId, profile: PROFILE });
      if (stopFails) {
        await expect(cleanup).rejects.toThrow("source cleanup still pending");
        expect(await f.allocation()).toBeDefined();
      } else {
        await expect(cleanup).resolves.toBeUndefined();
        expect(await f.allocation()).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(capture!.selector));
      }
      expect(calls.map(({ argv }) => argv[1])).toEqual(["stop"]);
      expect((await warmImage())?.capture).toMatchObject({
        selector: capture!.selector,
        leaseId,
        phase: "uncertain",
      });
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
    },
  );

  it("prepares runtime without project capture for an opted-out profile", async () => {
    const profile = { ...PROFILE, warmImage: false };
    const f = projectFixture();
    const { options, provider, calls } = f;
    expect(provider.supportsProjectPreparation?.(profile)).toBe(false);
    await f.provision({}, profile);
    expect(options.project.prepare).not.toHaveBeenCalled();
    expect(options.prepareNodeRuntime).toHaveBeenCalledOnce();
    expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
    expect(commandCount(calls, "checkpoint")).toBe(0);
    expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
  });
});
