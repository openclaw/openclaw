import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import { scenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import { expectText, updateWarmImage } from "./crabbox-warm-scenarios.test-support.js";
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
    const unsupportedMessage = "x".repeat(1024);
    const receipt = unsupported
      ? { ...unsupportedCaptureReceipt(LEASE_ID), message: unsupportedMessage }
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
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toEqual([calls.at(-1)]);
    expect(warn).toHaveBeenCalledOnce();
    if (unsupported) {
      const image = (await listCrabboxWarmImages(crabboxState))[0];
      expect(image?.capture).toBeUndefined();
      expect({ allocations: image?.allocations, unsupported: image?.captureUnsupported }).toEqual({
        allocations: {},
        unsupported: {
          atMs: now,
          provider: "aws",
          message: unsupportedMessage,
        },
      });
      expectText(warn.mock.calls[0]?.[0], ["warm image capture unsupported:"], ["failed"]);
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
  const home = tempDirs.make("openclaw-crabbox-warm-scrub-");
  const at = (relative: string) => path.join(home, relative);
  const bin = at("bin");
  const workdir = at("crabbox-workdir");
  const envFile = at("crabbox-workdir/.crabbox/env/forwarded.env");
  const egressEnvFile = at("crabbox-workdir/.crabbox/env-setup");
  const scrubScript = at("crabbox-workdir/.crabbox/scripts/scrub.sh");
  const tmp = at("tmp");
  const fixedTmp = at("fixed-tmp");
  // Map the owned Linux /tmp root into the fixture without scanning host temporary files.
  const scrubInput = String(scrub?.options.input).replace('"/tmp"', JSON.stringify(fixedTmp));
  const retained = [
    ".npm/cached-package",
    ".openclaw-worker/bundle-hash/index.js",
    ".openclaw-worker/git-seeds/gateway/seed/file",
    "tmp/unrelated/keep",
    "crabbox-workdir/.npmrc",
    ".gitconfig",
  ].map(at);
  const removed = [
    ".openclaw/cloud-workers",
    ".openclaw-worker/workspaces",
    "crabbox-workdir/.crabbox/env",
    "tmp/openclaw-setup-egress.fixture",
    "fixed-tmp/openclaw-setup-egress.fixed",
    "crabbox-workdir/.crabbox/scripts",
  ].map(at);
  const write = (file: string, contents = "synthetic retained bytes") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  fs.mkdirSync(bin);
  const runtimeNode = at(".openclaw-worker/runtime-node/node");
  fs.mkdirSync(path.dirname(runtimeNode), { recursive: true });
  fs.symlinkSync(process.execPath, runtimeNode);
  fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  write(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
  for (const file of [
    ...retained,
    ...removed.map((directory) => path.join(directory, "fixture")),
  ]) {
    write(file);
  }
  write(egressEnvFile, "SETUP_TOKEN=synthetic-sentinel");
  write(scrubScript, scrubInput);
  const runtime = at(`.openclaw-worker/node-runtimes/${"a".repeat(64)}`);
  fs.mkdirSync(runtime, { recursive: true });
  const state = at(`.openclaw/cloud-workers/${LEASE_ID}`);
  fs.mkdirSync(state, { recursive: true });
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
  for (const file of [...removed, egressEnvFile]) {
    expect(fs.existsSync(file)).toBe(false);
  }
  for (const file of retained) {
    expect(fs.readFileSync(file, "utf8")).toBe("synthetic retained bytes");
  }
  write(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
  write(scrubScript, scrubInput);
  fs.writeFileSync(
    path.join(bin, "rm"),
    '#!/bin/sh\ncase "$*" in *".crabbox/env"*) exit 7;; esac\nexec /bin/rm "$@"\n',
    { mode: 0o700 },
  );
  expect(runScrub).toThrow();
  expect(fs.existsSync(envFile)).toBe(true);
});

it.each([
  ["aws", "aws-ebs-snapshot", "completed", 0],
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
  const initial = scenario();
  const lease = await initial.provision(OPERATION_ID, PROFILE, { machineClass: "fast" });
  await initial.provider.dispose();

  const restarted = scenario(undefined, initial.stateDir);
  await restarted.provider.inspect({ leaseId: lease.leaseId, profile: PROFILE });
  await restarted.stop(lease);

  expect(restarted.checkpoints("create")).toHaveLength(1);

  for (const [digit, machineClass] of [
    ["1", "standard"],
    ["2", "fast"],
  ] as const) {
    restarted.calls.length = 0;
    await restarted.provision(`provision:v2:${digit.repeat(64)}`, PROFILE, { machineClass });
    const fork = restarted.checkpoints("fork")[0];
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

it("does not change a checkpoint-bound lease to cold when the fork fails", async () => {
  const { provider, calls } = createWarmProvider(({ argv }) =>
    argv[2] === "fork" ? commandResult({ code: 7, stderr: "snapshot unavailable" }) : undefined,
  );
  await captureWarmImage(provider);
  for (let attempt = 0; attempt < 2; attempt++) {
    calls.length = 0;
    await expect(provisionWarmProfile(provider)).rejects.toThrow();
    const fork = calls.find(({ argv }) => argv[2] === "fork")?.argv;
    expect(fork?.[fork.indexOf("--lease-id") + 1]).toBe(LEASE_ID);
    expect(fork?.[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  }
});

it("verifies an unverified pending image before falling back to cold", async () => {
  const s = scenario(({ argv }) =>
    argv[2] === "inspect"
      ? jsonResult({
          localState: "metadata_available",
          providerState: "unverified_ref",
          nextAction: "fork_or_delete_local",
        })
      : undefined,
  );
  await s.capture();
  // Older captures can retain a pending projection; verify that stored state on reuse.
  updateWarmImage({ state: "pending" });
  s.calls.length = 0;

  const lease = await s.provision();

  expect(s.commands("warmup").length).toBeGreaterThan(0);
  await s.stop(lease);
  expect(s.checkpoints("create")).toEqual([]);
});
