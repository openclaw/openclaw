import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QA_CHILD_STDOUT_MAX_BYTES } from "./child-output.js";
import {
  assertQaGatewayCredentialLeaseQuarantine,
  createQaGatewayProcessBoundaryController,
  shouldRetainQaGatewayCredentialLease,
  type QaGatewayProcessBoundaryConfig,
} from "./gateway-process-boundary.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const MIN_QUARANTINE_TTL_MS = 2 * 60 * 60 * 1_000;
const RETAIN_LEASE_PREFIX = "retain-credential-lease-";
const { makeTempDir, cleanup } = createTempDirHarness();
const tempDir = () => makeTempDir("qa-process-boundary-");
afterEach(cleanup);

async function fixture() {
  const root = await tempDir();
  const tempRoot = path.join(root, "runtime");
  const evidenceDir = path.join(root, "evidence");
  await Promise.all([fs.mkdir(tempRoot), fs.mkdir(evidenceDir)]);
  const launcherPath = path.join(root, "launcher");
  const config: QaGatewayProcessBoundaryConfig = {
    kind: "linux-proc-v1",
    evidenceDir,
    expectedGid: process.getgid?.() ?? 1002,
    expectedUid: process.getuid?.() ?? 1001,
    forwardedEnvKeys: ["PATH", "HOME", "PATH"],
    runtimeArgsPrefix: ["--import", "/tmp/preload.mjs"],
    runtimeExecutablePath: process.execPath,
    terminationRetryTimeoutMs: 60_000,
  };
  const create = () => createQaGatewayProcessBoundaryController({ config, launcherPath, tempRoot });
  const prepare = (controller: Awaited<ReturnType<typeof create>>) =>
    controller.prepare({
      args: ["gateway", "run"],
      cwd: tempRoot,
      env: { HOME: path.join(tempRoot, "home"), PATH: process.env.PATH },
    });
  return { tempRoot, evidenceDir, launcherPath, create, prepare };
}

const writeJson = (file: string, value: unknown, mode?: number) =>
  fs.writeFile(file, `${JSON.stringify(value)}\n`, { mode });
const boundaryEnv = (evidenceDir: string) => ({
  OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR: evidenceDir,
});

describe("gateway process boundary", () => {
  it.runIf(process.platform === "linux")(
    "validates handoff, sandbox, and runtime proof through controller acceptance",
    async () => {
      const { tempRoot, launcherPath, create, prepare } = await fixture();
      // Keep the executable immutable so concurrent forks cannot inherit its writer.
      await fs.writeFile(`${launcherPath}.sh`, '#!/bin/sh\ncat "$3.runtime"\n');
      await fs.symlink(
        new URL("../test-fixtures/mantis-command.sh", import.meta.url),
        launcherPath,
      );
      const controller = await create();
      const prepared = await prepare(controller);
      const launcherPid = 4242;
      const runtimePid = 4243;
      const accept = (spawn: typeof prepared) =>
        controller.accept({
          child: { pid: launcherPid, exitCode: null, signalCode: null } as never,
          prepared: spawn,
        });
      const writeSandbox = (spawn: typeof prepared, envKeys = spawn.command.envKeys) => {
        const proof = { version: 1, generation: spawn.generation, status: "pass", envKeys };
        return writeJson(spawn.sandboxFilePath, proof, 0o640);
      };
      const runtime = {
        version: 1,
        generation: prepared.generation,
        pid: runtimePid,
        uid: process.getuid?.() ?? 1001,
        gid: process.getgid?.() ?? 1002,
        procStartTicks: "123",
        pgrp: launcherPid,
      };
      const handoff = {
        ...runtime,
        commandFile: {
          path: prepared.commandFilePath,
          sha256: prepared.commandSha256,
        },
      };
      await writeJson(prepared.identityFilePath, handoff, 0o640);
      await writeSandbox(prepared, ["PATH", "HOME", "PATH", "OPENCLAW_QA_SUT_PREENTRY_STOP"]);
      const cmdlineSha256 = createHash("sha256")
        .update(
          Buffer.from(`${[prepared.command.executable, ...prepared.command.argv].join("\0")}\0`),
        )
        .digest("hex");
      await writeJson(`${prepared.identityFilePath}.runtime`, {
        ...runtime,
        status: "pass",
        state: "T",
        cwd: await fs.realpath(tempRoot),
        executablePath: await fs.realpath(process.execPath),
        cmdlineSha256,
      });

      const identity = await accept(prepared);

      expect(identity).toMatchObject({
        generation: prepared.generation,
        pid: runtimePid,
        pgrp: launcherPid,
        preEntryCmdlineSha256: cmdlineSha256,
      });
      expect(JSON.parse(await fs.readFile(controller.evidencePath, "utf8"))).toMatchObject({
        launches: [{ generation: prepared.generation }],
      });

      // Whitespace leaves JSON valid, but oversized verification output must not
      // authenticate a truncated proof as a complete response.
      await fs.appendFile(
        `${prepared.identityFilePath}.runtime`,
        " ".repeat(QA_CHILD_STDOUT_MAX_BYTES),
      );
      await expect(controller.markReady(identity)).rejects.toThrow("proxy stdout exceeded");

      await fs.writeFile(`${launcherPath}.sh`, '#!/bin/sh\ncat "$3.runtime" >&2\nexit 7\n');
      await expect(controller.markReady(identity)).rejects.toThrow(
        "proxy exited 7 (stderr truncated)",
      );

      const malformed = await prepare(controller);
      await writeJson(
        malformed.identityFilePath,
        { ...handoff, generation: malformed.generation, pid: 1 },
        0o640,
      );
      await writeSandbox(malformed);
      await expect(accept(malformed)).rejects.toThrow("invalid process-boundary pid");
    },
  );

  it("retains a credential lease only for a regular boundary marker", async () => {
    const evidenceDir = await tempDir();
    const env = boundaryEnv(evidenceDir);
    const markerPath = path.join(evidenceDir, `${RETAIN_LEASE_PREFIX}controller.json`);

    await expect(shouldRetainQaGatewayCredentialLease(env)).resolves.toBe(false);
    await fs.writeFile(markerPath, "{}\n", { mode: 0o600 });
    await expect(shouldRetainQaGatewayCredentialLease(env)).resolves.toBe(true);
    await fs.rm(markerPath);
    await fs.symlink(path.join(evidenceDir, "missing"), markerPath);
    await expect(shouldRetainQaGatewayCredentialLease(env)).resolves.toBe(false);
  });

  it("requires a durable Convex lease before isolated execution", () => {
    const env = boundaryEnv("/tmp/process-boundary");
    const quarantine = (source: string, leaseTtlMs: number) => () =>
      assertQaGatewayCredentialLeaseQuarantine({ source, leaseTtlMs }, env);
    expect(quarantine("convex", MIN_QUARANTINE_TTL_MS - 1)).toThrow(
      "requires a credential lease TTL",
    );
    expect(quarantine("convex", MIN_QUARANTINE_TTL_MS)).not.toThrow();
    expect(quarantine("env", 0)).not.toThrow();
  });

  it.runIf(process.platform === "linux")(
    "uses a distinct evidence index for each controller",
    async () => {
      const { evidenceDir, create, prepare } = await fixture();
      const first = await create();
      const second = await create();

      expect(first.evidencePath).not.toBe(second.evidencePath);
      expect(path.dirname(first.evidencePath)).toBe(evidenceDir);

      await prepare(first);
      await prepare(second);
      expect(first.retainCredentialLeasePath).not.toBe(second.retainCredentialLeasePath);
      await expect(shouldRetainQaGatewayCredentialLease(boundaryEnv(evidenceDir))).resolves.toBe(
        true,
      );
      expect((await fs.stat(first.retainCredentialLeasePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(second.retainCredentialLeasePath)).mode & 0o777).toBe(0o600);
    },
  );
});
