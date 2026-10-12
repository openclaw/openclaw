import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { destroyAndWait, commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  listCrabboxWarmImages,
  recoverCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  createWarmProvider,
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

describe("Crabbox profile warm images", () => {
  it("records unsupported teardown capture without failing source stop", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { provider, calls, warn } = createWarmProvider(({ argv }) =>
      argv[2] === "create"
        ? commandResult({
            code: 2,
            stdout: JSON.stringify(unsupportedCaptureReceipt(LEASE_ID)),
          })
        : undefined,
    );
    await captureWarmImage(provider);
    expect(calls.at(-1)?.argv[1]).toBe("stop");
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
    const image = (await listCrabboxWarmImages(crabboxState))[0];
    expect(image?.capture).toBeUndefined();
    expect(image?.allocations).toEqual({});
    expect(image?.captureUnsupported).toEqual({
      atMs: now,
      provider: "aws",
      message: unsupportedCaptureReceipt(LEASE_ID).message,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("warm image capture unsupported:");
    expect(warn.mock.calls[0]?.[0]).not.toContain("failed");
  });
  it("captures distinct images when setup, machine class, desktop, provider, or setup environment names change", async () => {
    const profile = { ...PROFILE, setup: "install-node", setupEnv: ["WARM_B", "WARM_A"] };
    vi.stubEnv("WARM_A", "first-secret");
    vi.stubEnv("WARM_B", "second-secret");
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider, profile);

    for (const [index, changed] of [
      { ...profile, setup: "install-other-node" },
      { ...profile, class: "fast" },
      { ...profile, desktop: true },
      { ...profile, provider: "hetzner" },
      { ...profile, setupEnv: ["WARM_A"] },
    ].entries()) {
      calls.length = 0;
      await captureWarmImage(provider, changed, `provision:v2:${String(index + 1).repeat(64)}`);
      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    }
  });

  it("rejects explicit warm images without sizing before reading mutable setup inputs", async () => {
    const { provider, calls } = createWarmProvider();
    await expect(
      provisionWarmProfile(provider, {
        ...CLASSLESS_PROFILE,
        warmImage: true,
        setup: "install-node",
        setupEnv: ["WARM_POLICY_INPUT"],
      }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(calls).toEqual([]);
  });

  it.each(["standard"])(
    "never invokes checkpoint commands with warm images disabled and class %s",
    async (machineClass) => {
      const { provider, calls } = createWarmProvider();
      const profile = {
        ...CLASSLESS_PROFILE,
        ...(machineClass ? { class: machineClass } : {}),
        warmImage: false,
      };
      const lease = await provisionWarmProfile(provider, profile);

      await destroyAndWait(provider, { leaseId: lease.leaseId, profile });

      expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
      expect(calls.at(-1)?.argv[1]).toBe("stop");
      // Even without capture, the stop command owns termination after its timer fires.
      expect(provider.resolveDestroyTimeoutMs?.(profile)).toBeGreaterThan(
        calls.at(-1)!.options.timeoutMs,
      );
    },
  );

  it("scrubs every worker identity and workspace before capturing an enrolled lease", async () => {
    const { provider, calls } = createWarmProvider();
    const lease = await provisionWarmProfile(provider);
    calls.length = 0;

    await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });

    expect(calls.map(({ argv }) => argv.slice(1, argv[1] === "checkpoint" ? 3 : 2))).toEqual([
      ["run"],
      ["checkpoint", "create"],
      ["stop"],
    ]);
    const scrub = calls[0];
    expect(scrub?.argv).toContain("--script-stdin");
    expect(scrub?.options.input).toContain("$HOME/.openclaw/cloud-workers");

    expect(scrub?.options.input).toContain('rm -rf "$worker_root"');
    expect(scrub?.options.input).toContain('rm -rf "$HOME/.openclaw-worker/workspaces"');
    // Capture phases ride a full crabbox run/snapshot round trip; 60s starves
    // them under coordinator latency (live-measured on AWS 2026-08-26).
    expect(scrub?.options.timeoutMs).toBe(180_000);
    expect(calls[1]?.options.timeoutMs).toBe(48 * 60_000);
    expect(provider.resolveDestroyTimeoutMs?.(PROFILE)).toBeGreaterThanOrEqual(
      calls.reduce((total, call) => total + call.options.timeoutMs, 0),
    );
    const home = tempDirs.make("openclaw-crabbox-warm-scrub-");
    const workspace = path.join(
      home,
      ".openclaw",
      "cloud-workers",
      LEASE_ID,
      "node-host",
      "gateway",
      "workspaces",
      "session",
    );
    const npmCache = path.join(home, ".npm", "cached-package");
    const sshWorkspace = path.join(home, ".openclaw-worker", "workspaces", "session");
    const bundle = path.join(home, ".openclaw-worker", "bundle-hash", "index.js");
    const gitSeed = path.join(home, ".openclaw-worker", "git-seeds", "gateway", "seed", "file");
    const bin = path.join(home, "bin");
    const workdir = path.join(home, "crabbox-workdir");
    const envFile = path.join(workdir, ".crabbox", "env", "forwarded.env");
    const scrubScript = path.join(workdir, ".crabbox", "scripts", "scrub.sh");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(npmCache), { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.mkdirSync(path.dirname(scrubScript), { recursive: true });
    fs.writeFileSync(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
    fs.writeFileSync(scrubScript, String(scrub?.options.input));
    fs.writeFileSync(path.join(workspace, "private.txt"), "session workspace bytes");
    fs.writeFileSync(npmCache, "reusable npm package");
    for (const file of [path.join(sshWorkspace, "private.txt"), bundle, gitSeed]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file);
    }
    const runtime = path.join(home, ".openclaw-worker", "node-runtimes", "a".repeat(64));
    fs.mkdirSync(runtime, { recursive: true });
    const state = path.join(home, ".openclaw", "cloud-workers", LEASE_ID);
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
    try {
      execFileSync("/bin/bash", [scrubScript], {
        cwd: workdir,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
      if (nodeClosed) {
        expect((await nodeClosed)[1]).toBe("SIGTERM");
      }
    } finally {
      await stopNode();
    }
    expect(fs.existsSync(runtime)).toBe(true);
    expect(fs.existsSync(path.join(home, ".openclaw", "cloud-workers"))).toBe(false);
    expect(fs.existsSync(sshWorkspace)).toBe(false);
    expect(fs.existsSync(envFile)).toBe(false);
    expect(fs.existsSync(scrubScript)).toBe(false);
    expect(fs.readFileSync(npmCache, "utf8")).toBe("reusable npm package");
    expect(fs.readFileSync(bundle, "utf8")).toBe(bundle);
    expect(fs.readFileSync(gitSeed, "utf8")).toBe(gitSeed);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.mkdirSync(path.dirname(scrubScript), { recursive: true });
    fs.writeFileSync(envFile, "CRABBOX_WORKER_BOOTSTRAP_TOKEN=synthetic-expired-token");
    fs.writeFileSync(scrubScript, String(scrub?.options.input));
    fs.writeFileSync(
      path.join(bin, "rm"),
      '#!/bin/sh\ncase "$*" in *".crabbox/env"*) exit 7;; esac\nexec /bin/rm "$@"\n',
      { mode: 0o700 },
    );
    expect(() =>
      execFileSync("/bin/bash", [scrubScript], {
        cwd: workdir,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      }),
    ).toThrow();
    expect(fs.existsSync(envFile)).toBe(true);
    expect(calls[1]?.argv.slice(1)).toEqual([
      "checkpoint",
      "create",
      "--provider",
      "aws",
      "--id",
      LEASE_ID,
      "--mode",
      "native",
      "--wait",
      "--wait-timeout",
      "2700000ms",
      "--json",
    ]);
    calls.length = 0;
    await provisionWarmProfile(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
    expect(calls.some(({ argv }) => argv[2] === "inspect")).toBe(false);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  });

  it.each([
    {
      backend: "azure",
      kind: "azure-os-disk-snapshot",
      nativeState: "available",
      sourceLifecycleMs: 0,
    },
    {
      backend: "daytona",
      kind: "daytona-snapshot",
      nativeState: "active",
      sourceLifecycleMs: 3 * 60_000,
    },
    {
      backend: "machine0",
      kind: "machine0-image",
      nativeState: "ACTIVE",
      sourceLifecycleMs: 30 * 60_000,
    },
  ])(
    "reuses waited $backend images without repeating readiness inspection",
    async ({ backend, kind, nativeState, sourceLifecycleMs }) => {
      const profile = { ...PROFILE, provider: backend };
      const { provider, calls } = createWarmProvider(({ argv }) => {
        if (argv[2] === "create") {
          return commandResult({
            stdout: JSON.stringify({
              id: CHECKPOINT_ID,
              kind,
              leaseId: LEASE_ID,
              native: { state: nativeState },
            }),
          });
        }
        if (argv[2] === "inspect") {
          return commandResult({
            stdout: JSON.stringify({
              localState: "metadata_available",
              providerState: nativeState,
              nextAction: "fork_or_delete",
            }),
          });
        }
        return undefined;
      });
      await captureWarmImage(provider, profile);

      const create = calls.find(({ argv }) => argv[2] === "create");
      expect(create?.argv).toEqual([
        expect.any(String),
        "checkpoint",
        "create",
        "--provider",
        backend,
        "--id",
        LEASE_ID,
        "--mode",
        "native",
        "--wait",
        "--wait-timeout",
        "2700000ms",
        "--json",
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

  it.each<{
    action: "run" | "create";
    name: string;
    result: Partial<SpawnResult>;
    captureUncertain?: boolean;
  }>([
    {
      action: "create",
      name: "capture was not submitted",
      captureUncertain: false,
      result: {
        code: 7,
        stdout: JSON.stringify({
          schema: "crabbox.checkpoint.create.failure.v1",
          outcome: "not_submitted",
          provider: PROFILE.provider,
          leaseId: LEASE_ID,
          checkpointId: CHECKPOINT_ID,
          localReservation: "removed",
        }),
        stderr: "image submission rejected; source rollback failed",
      },
    },
  ])("warns once and still stops the enrolled lease when $name", async (testCase) => {
    const { action, result, captureUncertain = action === "create" } = testCase;
    let tearingDown = false;
    const { provider, calls, warn } = createWarmProvider(({ argv }) => {
      if (tearingDown && (argv[1] === action || argv[2] === action)) {
        return commandResult(result);
      }
      return undefined;
    });
    const lease = await provisionWarmProfile(provider);
    tearingDown = true;

    await expect(
      destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(calls.at(-1)?.argv[1]).toBe("stop");
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);

    tearingDown = false;
    calls.length = 0;
    if (captureUncertain) {
      // Failed creation can retain a paid artifact; retry requires explicit cleanup acknowledgment.
      const capture = (await listCrabboxWarmImages(crabboxState))[0]?.capture;
      expect(capture).toBeDefined();
      expect(warn.mock.calls[0]?.[0]).toContain("--recover");
      await recoverCrabboxWarmImageCapture(crabboxState, capture!.selector, true);
    } else {
      expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
      expect(warn.mock.calls[0]?.[0]).not.toContain("--recover");
    }
    await captureWarmImage(provider);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
  });

  it.each([{ machineClass: "standard", warmImage: true }])(
    "recovers enrolled class after restart (configured=$machineClass, warmImage=$warmImage)",
    async ({ machineClass, warmImage }) => {
      const initial = createWarmProvider();
      const profile = {
        ...CLASSLESS_PROFILE,
        ...(warmImage === undefined ? {} : { warmImage }),
        ...(machineClass ? { class: machineClass } : {}),
      };
      const lease = await provisionWarmProfile(initial.provider, profile, OPERATION_ID, "fast");
      await initial.provider.dispose();

      const restarted = createWarmProvider(undefined, initial.stateDir);
      await restarted.provider.inspect({ leaseId: lease.leaseId, profile });
      await destroyAndWait(restarted.provider, {
        leaseId: lease.leaseId,
        profile,
      });

      expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);

      restarted.calls.length = 0;
      await provisionWarmProfile(
        restarted.provider,
        profile,
        `provision:v2:${"1".repeat(64)}`,
        "standard",
      );
      expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
      expect(restarted.calls.some(({ argv }) => argv[2] === "fork")).toBe(false);

      restarted.calls.length = 0;
      await provisionWarmProfile(
        restarted.provider,
        profile,
        `provision:v2:${"2".repeat(64)}`,
        "fast",
      );
      const fork = restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv;
      expect(fork?.[fork.indexOf("--class") + 1]).toBe("fast");
    },
  );

  it.each(["standard"])(
    "never snapshots an inspection-only lease with configured class %s",
    async (machineClass) => {
      const { provider, calls } = createWarmProvider();
      const lease = {
        leaseId: LEASE_ID,
        profile: {
          ...CLASSLESS_PROFILE,
          warmImage: true,
          ...(machineClass ? { class: machineClass } : {}),
        },
      };

      await provider.inspect(lease);
      await destroyAndWait(provider, lease);

      expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
      expect(calls.at(-1)?.argv[1]).toBe("stop");
    },
  );

  it.each([
    ["the captured runtime", NODE_RUNTIME_IDENTITY, false],
    [
      "a different runtime",
      { ...NODE_RUNTIME_IDENTITY, nodeBootstrapSha256: "f".repeat(64) },
      true,
    ],
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
        assertCurrent: () => {},
        nodeRuntimeIdentity: identity,
        prepareNodeRuntime,
      });

      expect(calls.some(({ argv }) => argv[2] === "fork")).toBe(true);
      expect(prepareNodeRuntime).toHaveBeenCalledTimes(prepares ? 1 : 0);
    },
  );

  it.each([{ name: "the fork fails", result: { code: 7, stderr: "snapshot unavailable" } }])(
    "does not change a checkpoint-bound lease to cold when $name",
    async ({ result }) => {
      const { provider, calls } = createWarmProvider(({ argv }) =>
        argv[2] === "fork" ? commandResult(result) : undefined,
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
    },
  );

  it.each([["unverified_ref", "fork_or_delete_local", "warmup", true]])(
    "verifies pending image state %s/action %s before %s",
    async (providerState, nextAction, expectedCommand, retained) => {
      const { provider, calls } = createWarmProvider(({ argv }) =>
        argv[2] === "inspect"
          ? commandResult({
              stdout: JSON.stringify({
                localState: "metadata_available",
                ...(providerState ? { providerState } : {}),
                nextAction,
              }),
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

      expect(
        calls.some(({ argv }) => argv[1] === expectedCommand || argv[2] === expectedCommand),
      ).toBe(true);
      if (retained) {
        await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });
        expect(calls.some(({ argv }) => argv[2] === "create")).toBe(false);
      } else {
        expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(true);
        await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });
        expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      }
    },
  );
});
