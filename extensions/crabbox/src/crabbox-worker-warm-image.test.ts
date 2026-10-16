import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { destroyAndWait, commandResult } from "./crabbox-worker-provider.test-support.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  createWarmProvider,
  jsonResult,
  provisionWarmProfile,
  CHECKPOINT_ID,
  CLASSLESS_PROFILE,
  LEASE_ID,
  NODE_RUNTIME_IDENTITY,
  OPERATION_ID,
  PROFILE,
  tempDirs,
  unsupportedCaptureReceipt,
} from "./crabbox-worker-warm-image.test-support.js";

const captureArgs = (provider: string) =>
  `checkpoint create --provider ${provider} --id ${LEASE_ID} --mode native --wait --wait-timeout 2700000ms --json`.split(
    " ",
  );

it.each([true, false])(
  "stops the source and settles failed capture (unsupported=%s)",
  async (unsupported) => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    let failCapture = true;
    const receipt = unsupported
      ? unsupportedCaptureReceipt(LEASE_ID)
      : {
          schema: "crabbox.checkpoint.create.failure.v1",
          outcome: "not_submitted",
          provider: PROFILE.provider,
          leaseId: LEASE_ID,
          checkpointId: CHECKPOINT_ID,
          localReservation: "removed",
        };
    const { provider, calls, warn } = createWarmProvider(({ argv }) =>
      failCapture && argv[2] === "create"
        ? commandResult({
            code: unsupported ? 2 : 7,
            stdout: JSON.stringify(receipt),
            ...(unsupported ? {} : { stderr: "image submission rejected; source rollback failed" }),
          })
        : undefined,
    );
    await captureWarmImage(provider);
    expect(calls.at(-1)?.argv[1]).toBe("stop");
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    if (unsupported) {
      const image = (await listCrabboxWarmImages(crabboxState))[0];
      expect(image?.capture).toBeUndefined();
      expect({ allocations: image?.allocations, unsupported: image?.captureUnsupported }).toEqual({
        allocations: {},
        unsupported: {
          atMs: now,
          provider: "aws",
          message: unsupportedCaptureReceipt(LEASE_ID).message,
        },
      });
      expect(warn.mock.calls[0]?.[0]).toContain("warm image capture unsupported:");
      expect(warn.mock.calls[0]?.[0]).not.toContain("failed");
    } else {
      expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
      expect(warn.mock.calls[0]?.[0]).not.toContain("--recover");
      failCapture = false;
      calls.length = 0;
      await captureWarmImage(provider);
      expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    }
  },
);
it("rejects explicit warm images without sizing before opening setup secrets", async () => {
  const { provider, calls } = createWarmProvider();
  await expect(
    provisionWarmProfile(provider, {
      ...CLASSLESS_PROFILE,
      warmImage: true,
      setup: "install-node",
      setupSecrets: { WARM_POLICY_INPUT: { source: "store", provider: "default", id: "SETUP" } },
    }),
  ).rejects.toMatchObject({ code: "invalid_profile" });
  expect(calls).toEqual([]);
});

it("scrubs every worker identity and workspace before capturing an enrolled lease", async () => {
  const { provider, calls } = createWarmProvider();
  const lease = await provisionWarmProfile(provider);
  calls.length = 0;

  await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });

  const captureCalls = calls.filter(
    ({ argv }) => argv[1] === "run" || argv[1] === "checkpoint" || argv[1] === "stop",
  );
  expect(captureCalls.map(({ argv }) => argv.slice(1, argv[1] === "checkpoint" ? 3 : 2))).toEqual([
    ["run"],
    ["checkpoint", "create"],
    ["stop"],
  ]);
  const scrub = captureCalls[0];
  expect(scrub?.argv).toContain("--script-stdin");
  // AWS coordinator round trips starved the old 60s budget (live-measured 2026-08-26).
  expect(scrub?.options.timeoutMs).toBe(180_000);
  expect(captureCalls[1]?.options.timeoutMs).toBe(48 * 60_000);
  expect(provider.resolveDestroyTimeoutMs?.(PROFILE)).toBeGreaterThanOrEqual(
    calls.reduce((total, call) => total + call.options.timeoutMs, 0),
  );
  const home = tempDirs.make("openclaw-crabbox-warm-scrub-");
  const at = (relative: string) => path.join(home, relative);
  const workspace = at(`.openclaw/cloud-workers/${LEASE_ID}/node-host/gateway/workspaces/session`);
  const npmCache = at(".npm/cached-package");
  const sshWorkspace = at(".openclaw-worker/workspaces/session");
  const bundle = at(".openclaw-worker/bundle-hash/index.js");
  const gitSeed = at(".openclaw-worker/git-seeds/gateway/seed/file");
  const bin = at("bin");
  const workdir = at("crabbox-workdir");
  const envFile = path.join(workdir, ".crabbox", "env", "forwarded.env");
  const egressEnvFile = path.join(workdir, ".crabbox", "env-setup");
  const scrubScript = path.join(workdir, ".crabbox", "scripts", "scrub.sh");
  const tmp = at("tmp");
  const setupCa = path.join(tmp, "openclaw-setup-egress.fixture", "ca.pem");
  const fixedTmp = at("fixed-tmp");
  const fixedSetupCa = path.join(fixedTmp, "openclaw-setup-egress.fixed", "ca.pem");
  // Map the owned Linux /tmp root into the fixture without scanning host temporary files.
  const scrubInput = String(scrub?.options.input).replace('"/tmp"', JSON.stringify(fixedTmp));
  const unrelatedTemp = path.join(tmp, "unrelated", "keep");
  const repoConfig = path.join(workdir, ".npmrc");
  const homeConfig = at(".gitconfig");
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  fs.mkdirSync(bin);
  const runtimeNode = at(".openclaw-worker/runtime-node/node");
  fs.mkdirSync(path.dirname(runtimeNode), { recursive: true });
  fs.symlinkSync(process.execPath, runtimeNode);
  fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  write(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
  write(egressEnvFile, "SETUP_TOKEN=synthetic-sentinel");
  for (const file of [setupCa, fixedSetupCa, unrelatedTemp, repoConfig, homeConfig]) {
    write(file, "preserved configuration or temporary data");
  }
  write(scrubScript, scrubInput);
  write(path.join(workspace, "private.txt"), "session workspace bytes");
  write(npmCache, "reusable npm package");
  for (const file of [path.join(sshWorkspace, "private.txt"), bundle, gitSeed]) {
    write(file, file);
  }
  const runtime = path.join(home, ".openclaw-worker", "node-runtimes", "a".repeat(64));
  fs.mkdirSync(runtime, { recursive: true });
  const state = at(`.openclaw/cloud-workers/${LEASE_ID}`);
  fs.symlinkSync(runtime, path.join(state, "runtime"));
  const node =
    process.platform === "linux"
      ? spawn(
          process.execPath,
          [
            "-e",
            'process.title = "openclaw-node"; process.stdout.write("ready"); setInterval(() => {}, 60000);',
          ],
          {
            cwd: runtime,
            env: { ...process.env, OPENCLAW_STATE_DIR: state },
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
          },
        )
      : undefined;
  const nodeClosed = node ? once(node, "close") : undefined;
  if (node) {
    await once(node.stdout!, "data");
    fs.writeFileSync(path.join(state, "node.pid"), String(node.pid));
  }
  const stopNode = async () => {
    if (node?.pid && node.exitCode === null && node.signalCode === null) {
      try {
        process.kill(-node.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
      await nodeClosed;
    }
  };
  const runScrub = () =>
    execFileSync("/bin/bash", [scrubScript], {
      cwd: workdir,
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: tmp,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
  try {
    runScrub();
    if (nodeClosed) {
      expect((await nodeClosed)[1]).toBe("SIGTERM");
    }
  } finally {
    await stopNode();
  }
  expect(fs.existsSync(runtime)).toBe(true);
  expect(fs.readlinkSync(runtimeNode)).toBe(process.execPath);
  for (const file of [
    at(".openclaw/cloud-workers"),
    sshWorkspace,
    envFile,
    egressEnvFile,
    path.dirname(setupCa),
    path.dirname(fixedSetupCa),
    scrubScript,
  ]) {
    expect(fs.existsSync(file)).toBe(false);
  }
  for (const file of [unrelatedTemp, repoConfig, homeConfig]) {
    expect(fs.readFileSync(file, "utf8")).toBe("preserved configuration or temporary data");
  }
  expect(fs.readFileSync(npmCache, "utf8")).toBe("reusable npm package");
  expect(fs.readFileSync(bundle, "utf8")).toBe(bundle);
  expect(fs.readFileSync(gitSeed, "utf8")).toBe(gitSeed);
  write(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
  write(scrubScript, scrubInput);
  fs.writeFileSync(
    path.join(bin, "rm"),
    '#!/bin/sh\ncase "$*" in *".crabbox/env"*) exit 7;; esac\nexec /bin/rm "$@"\n',
    { mode: 0o700 },
  );
  expect(runScrub).toThrow();
  expect(fs.existsSync(envFile)).toBe(true);
  expect(captureCalls[1]?.argv.slice(1)).toEqual(captureArgs("aws"));
  calls.length = 0;
  await provisionWarmProfile(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
  expect(calls.some(({ argv }) => argv[2] === "inspect")).toBe(false);
  expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
  expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
});

it.each([
  ["azure", "azure-os-disk-snapshot", "available", 0],
  ["daytona", "daytona-snapshot", "active", 3 * 60_000],
  ["machine0", "machine0-image", "ACTIVE", 30 * 60_000],
] as const)(
  "reuses waited %s images without repeating readiness inspection",
  async (backend, kind, nativeState, sourceLifecycleMs) => {
    const profile = { ...PROFILE, provider: backend };
    const { provider, calls } = createWarmProvider(({ argv }) => {
      if (argv[2] === "create") {
        return jsonResult({
          id: CHECKPOINT_ID,
          kind,
          leaseId: LEASE_ID,
          native: { state: nativeState },
        });
      }
      if (argv[2] === "inspect") {
        return jsonResult({
          localState: "metadata_available",
          providerState: nativeState,
          nextAction: "fork_or_delete",
        });
      }
      return undefined;
    });
    await captureWarmImage(provider, profile);

    const create = calls.find(({ argv }) => argv[2] === "create");
    expect(create?.argv).toEqual([
      expect.any(String),
      ...captureArgs(backend),
      ...(["azure", "daytona"].includes(backend) ? ["--no-reboot=false"] : []),
      ...(backend === "machine0" ? ["--strategy", "image"] : []),
    ]);
    // Native capture gets Crabbox's 45m plus command overhead and separate source recovery.
    expect(create?.options.timeoutMs).toBe(48 * 60_000 + sourceLifecycleMs);
    const scrub = calls.find(({ options }) =>
      options.input?.toString().includes("CRABBOX_SCRUB_NODE_SCRIPT"),
    );
    expect(scrub?.options.timeoutMs).toBe(180_000);
    const teardownCalls = calls.slice(calls.indexOf(scrub!));
    // Include stop after capture: the caller must not time out while either still owns the lease.
    expect(provider.resolveDestroyTimeoutMs?.(profile)).toBeGreaterThanOrEqual(
      teardownCalls.reduce((total, call) => total + call.options.timeoutMs, 0),
    );
    expect((await listCrabboxWarmImages(crabboxState))[0]?.state).toBe("available");
    calls.length = 0;
    await provisionWarmProfile(provider, profile, `provision:v2:${"2".repeat(64)}`);
    expect(calls.some(({ argv }) => argv[2] === "inspect")).toBe(false);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  },
);

it("recovers enrolled class after restart", async () => {
  const initial = createWarmProvider();
  const lease = await provisionWarmProfile(initial.provider, PROFILE, OPERATION_ID, "fast");
  await initial.provider.dispose();

  const restarted = createWarmProvider(undefined, initial.stateDir);
  await restarted.provider.inspect({ leaseId: lease.leaseId, profile: PROFILE });
  await destroyAndWait(restarted.provider, { leaseId: lease.leaseId, profile: PROFILE });

  expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);

  for (const [digit, machineClass] of [
    ["1", "standard"],
    ["2", "fast"],
  ] as const) {
    restarted.calls.length = 0;
    await provisionWarmProfile(
      restarted.provider,
      PROFILE,
      `provision:v2:${digit.repeat(64)}`,
      machineClass,
    );
    const fork = restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv;
    if (machineClass === "standard") {
      expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
      expect(fork).toBeUndefined();
    } else {
      expect(fork?.[fork.indexOf("--class") + 1]).toBe("fast");
    }
  }
});

it("never snapshots an inspection-only lease with a configured class", async () => {
  const { provider, calls } = createWarmProvider();
  const lease = { leaseId: LEASE_ID, profile: PROFILE };

  await provider.inspect(lease);
  await destroyAndWait(provider, lease);

  expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
  expect(calls.at(-1)?.argv[1]).toBe("stop");
});

it.each([
  ["the captured runtime", NODE_RUNTIME_IDENTITY, false],
  ["a different runtime", { ...NODE_RUNTIME_IDENTITY, nodeBootstrapSha256: "f".repeat(64) }, true],
] as const)(
  "prepares the node runtime on a fork only for %s",
  async (_label, identity, prepares) => {
    const initial = createWarmProvider();
    await captureWarmImage(initial.provider);
    const { provider, calls } = createWarmProvider(undefined, initial.stateDir);
    const prepareNodeRuntime = vi.fn(async () => ({
      nodeBootstrap: createNodeBootstrapFixture(),
      workerBundle: createWorkerArchiveFixture(),
    }));

    await provisionWarmProfile(provider, PROFILE, OPERATION_ID, undefined, {
      nodeRuntimeIdentity: identity,
      prepareNodeRuntime,
    });

    expect(calls.some(({ argv }) => argv[2] === "fork")).toBe(true);
    expect(prepareNodeRuntime).toHaveBeenCalledTimes(prepares ? 1 : 0);
  },
);

it("does not change a checkpoint-bound lease to cold when the fork fails", async () => {
  const { provider, calls } = createWarmProvider(({ argv }) =>
    argv[2] === "fork" ? commandResult({ code: 7, stderr: "snapshot unavailable" }) : undefined,
  );
  await captureWarmImage(provider);
  calls.length = 0;

  await expect(provisionWarmProfile(provider)).rejects.toThrow();

  const fork = calls.find(({ argv }) => argv[2] === "fork")?.argv;
  const warmup = calls.find(({ argv }) => argv[1] === "warmup")?.argv;
  expect(fork?.[fork.indexOf("--lease-id") + 1]).toBe(LEASE_ID);
  expect(warmup).toBeUndefined();
  calls.length = 0;
  await expect(provisionWarmProfile(provider)).rejects.toThrow();
  expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
  expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
});

it("verifies an unverified pending image before falling back to cold", async () => {
  const { provider, calls } = createWarmProvider(({ argv }) =>
    argv[2] === "inspect"
      ? jsonResult({
          localState: "metadata_available",
          providerState: "unverified_ref",
          nextAction: "fork_or_delete_local",
        })
      : undefined,
  );
  await captureWarmImage(provider);
  // Older captures can retain a pending projection; verify that stored state on reuse.
  const store = openWarmImageStore();
  const { key, value } = store.entries()[0]!;
  store.update(key, () => ({ ...value, image: { ...value.image!, state: "pending" } }));
  calls.length = 0;

  const lease = await provisionWarmProfile(provider);

  expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
  await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });
  expect(calls.some(({ argv }) => argv[2] === "create")).toBe(false);
});
