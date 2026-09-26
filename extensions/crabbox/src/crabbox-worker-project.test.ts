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
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { CrabboxCheckpointCreateError } from "./crabbox-worker-warm-image-checkpoint.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
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

type ProvisionOptions = Parameters<WorkerProvider<1>["provision"]>[2];

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
  it("continues cold after unsupported native capture and captures again on the next provision", async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const events: string[] = [];
    let current = projectOptions(events);
    let unsupported = true;
    const profile = { ...CLASSLESS_PROFILE, provider: "hetzner", class: "standard" };
    const { provider, calls, warn } = createWarmProvider((call) => {
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
    });
    const source = await provider.provision(profile, "unsupported-project", current.options);
    expect(events).toEqual([
      "project-prepared",
      "runtime-granted",
      "runtime-install",
      "capture",
      "enrollment-begun",
      "enrollment-install",
    ]);
    expect(calls.filter(({ argv }) => argv[1] === "inspect")).toHaveLength(1);
    expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
    expect((await listCrabboxWarmImages(crabboxState))[0]).toMatchObject({
      captureUnsupported: {
        atMs: now,
        provider: "hetzner",
        message: unsupportedCaptureReceipt("unused").message,
      },
      allocations: { [source.leaseId]: { phase: "enrolled", choice: { kind: "cold" } } },
    });
    expect((await listCrabboxWarmImages(crabboxState))[0]?.capture).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      `Crabbox warm image capture unsupported: ${unsupportedCaptureReceipt("unused").message}. Workers for this profile use an existing compatible snapshot when one is available and otherwise provision cold; each eligible worker retries capture, so Crabbox configuration changes apply to the next dispatch. Set settings.warmImage: false on the profile to stop capture attempts.`,
    );
    await provider.destroy({ ...source, profile });
    // The retained refusal must not suppress the next attempt once Crabbox can capture.
    expect((await listCrabboxWarmImages(crabboxState))[0]?.captureUnsupported?.atMs).toBe(now);
    calls.length = 0;
    clock.mockReturnValue(now + 60_000);
    unsupported = false;
    current = projectOptions([]);
    await provider.provision(profile, "supported-next", current.options);
    expect(current.options.prepareNodeRuntime).toHaveBeenCalledOnce();
    expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    expect((await listCrabboxWarmImages(crabboxState))[0]?.checkpointId).toBe(CHECKPOINT_ID);
    expect((await listCrabboxWarmImages(crabboxState))[0]?.captureUnsupported).toBeUndefined();
  });

  it.skipIf(process.platform === "win32").each(["none", "runtime", "scrub"] as const)(
    "prepares and scrubs in one settled command before capture (failure=%s)",
    async (failure) => {
      const home = fs.realpathSync(tempDirs.make("openclaw-crabbox-capture-command-"));
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
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
        ".openclaw-worker",
        "node-runtimes",
        nodeBootstrap.sha256,
        "node_modules",
        "openclaw",
      );
      const retainedArchive = path.join(packageRoot, workerBundle.packageRelativePath);
      const privateFiles = [
        path.join(home, ".openclaw", "cloud-workers", "previous-worker", "setup-code"),
        path.join(home, ".openclaw-worker", "workspaces", "previous-session", "private.txt"),
        path.join(home, ".crabbox", "env", "forwarded.env"),
        path.join(home, ".crabbox", "scripts", "prepare.sh"),
      ];
      for (const file of [...privateFiles, retainedArchive]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "synthetic private state");
      }
      fs.writeFileSync(retainedArchive, archive);
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: failure === "runtime" ? "0.0.0" : "2026.8.1" }),
      );
      fs.writeFileSync(
        path.join(packageRoot, "openclaw.mjs"),
        `import fs from "node:fs";
import path from "node:path";
if (process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN || !fs.existsSync(${JSON.stringify(privateFiles[0])})) process.exit(9);
fs.writeFileSync(path.join(process.env.HOME, "runtime-verified"), "verified");
console.log("OpenClaw 2026.8.1");
`,
      );
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "node"),
        `#!/bin/sh
set -eu
if [ -f "$HOME/runtime-verified" ] && [ -n "\${CRABBOX_WORKER_BOOTSTRAP_TOKEN-}" ]; then
  echo "bootstrap credentials reached scrub" >&2
  exit 9
fi
exec "$CRABBOX_TEST_NODE" "$@"
`,
        { mode: 0o700 },
      );
      if (failure === "scrub") {
        fs.writeFileSync(
          path.join(bin, "rm"),
          '#!/bin/sh\ncase "$*" in *".crabbox/env"*) exit 7;; esac\nexec /bin/rm "$@"\n',
          { mode: 0o700 },
        );
      }
      let preparationCommands = 0;
      let filesAtCapture: boolean[] | undefined;
      let archiveAtCapture: Buffer | undefined;
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[2] === "create") {
          filesAtCapture = privateFiles.map((file) => fs.existsSync(file));
          archiveAtCapture = fs.readFileSync(retainedArchive);
        }
        if (
          call.argv[1] !== "run" ||
          call.options.input === "project-checkout" ||
          events.includes("enrollment-begun")
        ) {
          return undefined;
        }
        preparationCommands += 1;
        const scriptPath = privateFiles[3]!;
        fs.writeFileSync(scriptPath, String(call.options.input));
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
        return commandResult({ code: result.status, stdout: result.stdout, stderr: result.stderr });
      });

      const provision = provider.provision(PROFILE, "capture-command", options);
      if (failure === "none") {
        await expect(provision).resolves.toMatchObject({ node: { deviceId: "project-node" } });
        expect(filesAtCapture).toEqual([false, false, false, false]);
        expect(archiveAtCapture).toEqual(archive);
        expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      } else {
        await expect(provision).rejects.toThrow();
        expect(filesAtCapture).toBeUndefined();
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
        expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
        expect(fs.existsSync(privateFiles[2]!)).toBe(true);
      }
      expect(preparationCommands).toBe(1);
      expect(fs.existsSync(path.join(home, "runtime-verified"))).toBe(failure !== "runtime");
      expect((await listCrabboxWarmImages(crabboxState)).every((image) => !image.capture)).toBe(
        true,
      );
    },
  );

  it("reports checkpoint rejection and cleanup failure while retaining capture recovery", async () => {
    const diagnostic =
      'coordinator POST /v1/checkpoints: http 429: {"error":"checkpoint_limit_exceeded","message":"checkpoint admission limit exceeded: scope=owner observed=10 limit=10"}';
    const { options } = projectOptions([]);
    const { provider, calls } = createWarmProvider(({ argv }) => {
      if (argv[2] === "create") {
        return commandResult({ code: 5, stderr: diagnostic });
      }
      if (argv[1] === "stop") {
        return commandResult({ code: 2, stderr: "source has unresolved checkpoint chk_quota" });
      }
      return undefined;
    });

    const failure = await provider
      .provision(PROFILE, "quota-rejection", options)
      .catch((error: unknown) => error);
    const message = formatErrorMessage(failure);
    expect(message).toContain(diagnostic);
    expect(message).toContain("capture is unresolved");
    const capture = (await listCrabboxWarmImages(crabboxState))[0]?.capture;
    expect(capture).toMatchObject({ phase: "uncertain" });
    expect(message).toContain(`--recover ${capture!.selector}`);
    expect(message).toContain("source has unresolved checkpoint chk_quota");
    expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
  });

  it.each([
    { replaced: false, unsupported: false },
    { replaced: true, unsupported: false },
    { replaced: true, unsupported: true },
  ])(
    "clears only its own rejected capture and still stops the source (replaced=$replaced, unsupported=$unsupported)",
    async ({ replaced, unsupported }) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const leaseId = operationLeaseId("not-submitted");
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
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
            unsupported ? unsupportedCaptureReceipt(leaseId) : notSubmittedReceipt(leaseId),
          ),
          stderr: "image submission rejected; source rollback failed",
        });
      });

      await expect(provider.provision(PROFILE, "not-submitted", options)).rejects.toThrow(
        "image submission rejected; source rollback failed",
      );
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
      expect(calls.find(({ argv }) => argv[1] === "stop")?.argv).toContain(leaseId);
      if (replaced) {
        expect((await listCrabboxWarmImages(crabboxState))[0]?.captureUnsupported).toBeUndefined();
        expect((await listCrabboxWarmImages(crabboxState))[0]?.capture).toMatchObject({
          selector: "replacement-capture",
          leaseId: "cbx_replacement",
          phase: "creating",
        });
        expect(
          (await listCrabboxWarmImages(crabboxState))[0]?.allocations[leaseId],
        ).toBeUndefined();
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
        projectOptions([], new AbortController(), preparation).options,
      );
      await initial.provider.destroy({ ...baseline, profile: PROFILE });
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
        expect((await listCrabboxWarmImages(crabboxState))[0]?.allocations[leaseId]?.phase).toBe(
          crash === "pending" ? "pending" : "prepared",
        );
        expect((await listCrabboxWarmImages(crabboxState))[0]?.capture).toBeUndefined();
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
    const events: string[] = [];
    const { options, observe } = projectOptions(events);
    const entered = createDeferred<void>();
    const available = createDeferred<void>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { provider, calls } = createWarmProvider(async (call) => {
      observe(call);
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
          available.promise.then(() =>
            checkpointResult(CHECKPOINT_ID, operationLeaseId("retained-capture"), "available"),
          ),
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
    const profile = PROFILE;
    const provision = provider.provision(profile, "retained-capture", options).then(
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
      expect(provider.resolveProvisionTimeoutMs?.(profile)).toBeGreaterThan(
        calls.reduce((total, call) => total + call.options.timeoutMs, 0),
      );
    } finally {
      available.resolve();
      await provision;
      vi.useRealTimers();
    }
    expect((await listCrabboxWarmImages(crabboxState))[0]).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      state: "available",
      allocations: { [operationLeaseId("retained-capture")]: { phase: "enrolled" } },
    });
    expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
    expect((await listCrabboxWarmImages(crabboxState))[0]?.capture).toBeUndefined();
  });

  it.each(["project transfer", "runtime grant", "runtime setup", "enrollment setup"] as const)(
    "cancels explicit Stop during %s without replacing its narrower grant signal",
    async (phase) => {
      const events: string[] = [];
      const controller = new AbortController();
      const reason = new DOMException("Stop snapshot provisioning", "AbortError");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const { options, observe } = projectOptions(events);
      const provisionOptions = { ...options, signal: controller.signal };
      let commandSignal: AbortSignal | undefined;
      const { provider, calls } = createWarmProvider(async (call) => {
        observe(call);
        const input = call.options.input?.toString();
        const currentPhase =
          input === "project-checkout"
            ? "project transfer"
            : call.argv[1] === "run" && call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")
              ? events.includes("enrollment-begun")
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
      if (phase === "runtime grant") {
        options.prepareNodeRuntime.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return {
            nodeBootstrap: createNodeBootstrapFixture(),
            workerBundle: createWorkerArchiveFixture(),
            signal: options.project.signal,
          };
        });
      }
      let settled = false;
      const operation = provider
        .provision(PROFILE, `stop-${phase}`, provisionOptions)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await entered.promise;
      const commandCount = calls.length;
      try {
        controller.abort(reason);
        await setImmediate();
        expect(options.project.signal.aborted).toBe(false);
        if (phase !== "runtime grant") {
          expect(commandSignal?.aborted).toBe(true);
        }
        expect(settled).toBe(false);
        expect(calls).toHaveLength(commandCount);
      } finally {
        release.resolve();
        await operation;
      }
      expect(await operation).toBe(reason);
      expect(calls).toHaveLength(commandCount);
      if (phase !== "enrollment setup") {
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      }
      expect(calls.some(({ argv }) => argv[1] === "stop" || argv[1] === "heartbeat")).toBe(false);
    },
  );

  it.each(["runtime-install", "enrollment-install"])(
    "completes internal %s without another provider readiness request",
    async (phase) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if ((call.argv[1] === "inspect" || call.argv[1] === "status") && events.at(-1) === phase) {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });

      await expect(
        provider.provision(PROFILE, `internal-${phase}`, options),
      ).resolves.toMatchObject({
        node: { deviceId: "project-node" },
      });
      expect(events).toContain(phase);
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
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
        "project-prepared",
        "runtime-granted",
        "runtime-install",
        "capture",
        "enrollment-begun",
        "enrollment-install",
      ]);
      expect((await listCrabboxWarmImages(crabboxState))[0]).toMatchObject({
        projectKey: PROJECT_KEY,
        checkpointId: CHECKPOINT_ID,
        allocations: {
          [operationLeaseId("project-first")]: { phase: "enrolled", baseCommit: BASE_COMMIT },
        },
      });
      // The first worker is still running: a new session can already use its clean image.
      calls.length = 0;
      events.length = 0;
      current = projectOptions(events);
      await provider.provision(profile, "project-second", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
      expect(calls.some(({ argv }) => argv[1] === "warmup" || argv[2] === "create")).toBe(false);
      // Waited capture already established readiness; reuse does not repeat the inspection.
      expect(calls.filter(({ argv }) => argv[2] === "inspect")).toHaveLength(0);
      expect(events).toEqual([
        ...(desktop ? ["desktop"] : []),
        "project-prepared",
        "enrollment-begun",
        "enrollment-install",
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
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      if (failure === "grant") {
        options.prepareNodeRuntime.mockRejectedValueOnce(new Error("runtime grant failed"));
      }
      let captured = false;
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        captured ||= call.argv[2] === "create";
        if (captured && failure === "readiness" && call.argv[1] === "inspect") {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });
      await expect(provider.provision(PROFILE, `runtime-${failure}`, options)).rejects.toThrow();
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(calls.some(({ argv }) => argv[2] === "create")).toBe(failure === "readiness");
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(
        failure === "readiness" ? 0 : 1,
      );
      expect((await listCrabboxWarmImages(crabboxState)).every((image) => !image.capture)).toBe(
        true,
      );
      if (failure === "readiness") {
        expect(
          (await listCrabboxWarmImages(crabboxState))[0]?.allocations[
            operationLeaseId(`runtime-${failure}`)
          ],
        ).toMatchObject({ phase: "prepared", choice: { kind: "cold" } });
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "fences a runtime grant that will %s after project ownership changes",
    async (outcome) => {
      const events: string[] = [];
      const controller = new AbortController();
      const { options, observe } = projectOptions(events, controller);
      const { provider, calls } = createWarmProvider(observe);
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
          controller.abort(closed);
          throw closed;
        }
        return {
          nodeBootstrap: createNodeBootstrapFixture(),
          workerBundle: createWorkerArchiveFixture(),
          signal: new AbortController().signal,
        };
      });

      await expect(
        provider.provision(PROFILE, `stale-grant-${outcome}`, options),
      ).rejects.toMatchObject({
        name: "AbortError",
      });

      expect(events).not.toContain("runtime-install");
      expect(calls.some(({ argv }) => argv[1] === "stop" || argv[2] === "create")).toBe(false);
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect((await listCrabboxWarmImages(crabboxState))[0]).toMatchObject({
        allocations: {
          [operationLeaseId(`stale-grant-${outcome}`)]: {
            phase: "prepared",
            choice: { kind: "cold" },
          },
        },
      });
      expect((await listCrabboxWarmImages(crabboxState))[0]?.capture).toBeUndefined();
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
      const events: string[] = [];
      const controller = new AbortController();
      const { options, observe } = projectOptions(events, controller);
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[2] !== "create") {
          return undefined;
        }
        if (failure === "aborted") {
          controller.abort();
        }
        // The command combines caller cancellation and the project grant; identity may differ.
        expect(call.options.signal).toBeDefined();
        expect(call.options.signal?.aborted).toBe(controller.signal.aborted);
        expect(call.options.signal?.reason).toBe(controller.signal.reason);
        return commandResult({
          code: 7,
          stderr: "capture failed",
          stdout: JSON.stringify({
            ...notSubmittedReceipt(operationLeaseId(`project-${failure}`)),
            ...receipt,
          }),
          ...result,
        });
      });

      await expect(provider.provision(PROFILE, `project-${failure}`, options)).rejects.toThrow();

      expect(events).toContain("capture");
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(events).not.toContain("enrollment-install");
      expect((await listCrabboxWarmImages(crabboxState))[0]?.capture?.phase).toBe("uncertain");
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(failure !== "aborted");
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
    const { options } = projectOptions([]);
    const { provider } = createWarmProvider(({ argv }) =>
      argv[2] === "create"
        ? commandResult({
            code: 2,
            stdout: JSON.stringify(unsupportedCaptureReceipt("cbx_other")),
          })
        : undefined,
    );
    await expect(
      provider.provision(PROFILE, "unsupported-different-lease", options),
    ).rejects.toThrow("capture is unresolved");
    expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
    const image = (await listCrabboxWarmImages(crabboxState))[0];
    expect(image?.capture?.phase).toBe("uncertain");
    expect(image?.captureUnsupported).toBeUndefined();
  });

  it.each([false, true])(
    "preserves capture uncertainty but reports the source cleanup result after cancellation (stopFails=%s)",
    async (stopFails) => {
      const controller = new AbortController();
      const { options } = projectOptions([], controller);
      const leaseId = operationLeaseId("cancelled-project-capture");
      const { provider, calls, warn } = createWarmProvider(({ argv }) => {
        if (argv[2] === "create") {
          controller.abort();
          return commandResult({ code: 2, stderr: "capture interrupted" });
        }
        if (argv[1] === "stop" && stopFails) {
          return commandResult({ code: 5, stderr: "source cleanup still pending" });
        }
        return undefined;
      });

      await expect(
        provider.provision(PROFILE, "cancelled-project-capture", options),
      ).rejects.toMatchObject({ name: "AbortError" });
      const capture = (await listCrabboxWarmImages(crabboxState))[0]?.capture;
      expect(capture).toMatchObject({ leaseId, phase: "uncertain" });
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
      calls.length = 0;
      warn.mockClear();

      const cleanup = provider.destroy({ leaseId, profile: PROFILE });
      if (stopFails) {
        await expect(cleanup).rejects.toThrow("source cleanup still pending");
        expect((await listCrabboxWarmImages(crabboxState))[0]?.allocations[leaseId]).toBeDefined();
      } else {
        await expect(cleanup).resolves.toBeUndefined();
        expect(
          (await listCrabboxWarmImages(crabboxState))[0]?.allocations[leaseId],
        ).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(capture!.selector));
      }
      expect(calls.map(({ argv }) => argv[1])).toEqual(["stop"]);
      expect((await listCrabboxWarmImages(crabboxState))[0]?.capture).toMatchObject({
        selector: capture!.selector,
        leaseId,
        phase: "uncertain",
      });
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
    },
  );

  it("preserves the lease when enrollment's owning operation has closed", async () => {
    const { provider, calls } = createWarmProvider();
    const beginNodeEnrollment = vi.fn(async () => {
      throw new DOMException("Worker provisioning operation is closed", "AbortError");
    });
    await expect(
      provider.provision({ ...PROFILE, warmImage: false }, "closed-enrollment", {
        assertCurrent: () => {},
        beginNodeEnrollment,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(beginNodeEnrollment).toHaveBeenCalledOnce();
    expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
  });

  it.each([
    { ...PROFILE, warmImage: false },
    { ...CLASSLESS_PROFILE, class: "standard", setup: "true", setupEnv: ["PROJECT_SETUP_VALUE"] },
  ])("prepares runtime without project capture for opted-out profiles: %j", async (profile) => {
    vi.stubEnv("PROJECT_SETUP_VALUE", "synthetic");
    const events: string[] = [];
    const { options, observe } = projectOptions(events);
    const { provider, calls } = createWarmProvider((call) => observe(call));
    expect(provider.supportsProjectPreparation?.(profile)).toBe(false);
    await provider.provision(profile, "project-optout", options);
    expect(options.project.prepare).not.toHaveBeenCalled();
    expect(options.prepareNodeRuntime).toHaveBeenCalledOnce();
    expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
    expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
    expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
  });
});
