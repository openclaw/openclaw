import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import {
  failProvisionAfterCleanup,
  runProvisionSetup,
} from "./crabbox-worker-provision-commands.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    writeFile: vi.fn(actual.writeFile),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.resetAllMocks());

function createSetupFixture() {
  let authorized = true;
  const authorityError = new Error("worker turn authority changed");
  const runCommand = vi.fn<CrabboxCommandRunner>().mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
  const stopLease = vi.fn(async () => {});
  const params = {
    binary: "crabbox",
    provider: "aws",
    deadline: Date.now() + 60_000,
    inspect: { id: "cbx_setup_authority", state: "running", tailscaleEnabled: false },
    profile: parseCrabboxProfile({ provider: "aws", ttl: "24h", idleTimeout: "60m" }),
    phase: "profile setup",
    setup: "install-worker",
    forwardedEnv: { WORKER_ARTIFACT_TOKEN: "fixture-artifact-value" },
    runCommand,
    stopLease,
    assertAuthorized: () => {
      if (!authorized) {
        throw authorityError;
      }
    },
  };
  return {
    params,
    authorityError,
    revoke: () => {
      authorized = false;
    },
  };
}

describe("Crabbox cleanup settlement", () => {
  it.each([
    { name: "Error", original: new Error("provision failed") },
    { name: "frozen Error", original: Object.freeze(new Error("provision failed")) },
    { name: "object", original: { failure: "provision failed" } },
    { name: "string", original: "provision failed" },
    { name: "undefined", original: undefined },
  ])("preserves the original $name only after stop settles", async ({ original }) => {
    const { params } = createSetupFixture();
    const entered = createDeferred<void>();
    const stopped = createDeferred<void>();
    params.stopLease.mockImplementationOnce(async () => {
      entered.resolve();
      await stopped.promise;
    });
    let settled = false;
    const pending = failProvisionAfterCleanup({ ...params, id: params.inspect.id }, original).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    expect(settled).toBe(false);
    stopped.resolve();
    expect(await pending).toBe(original);
    expect(params.stopLease).toHaveBeenCalledOnce();
  });

  it("retains the exact lease and failures when stop is uncertain", async () => {
    const { params } = createSetupFixture();
    const original = new Error("source closed");
    const cleanupError = new Error("stop timed out");
    params.stopLease.mockRejectedValueOnce(cleanupError);
    const error = await failProvisionAfterCleanup(
      { ...params, id: params.inspect.id },
      original,
    ).catch((cause: unknown) => cause);
    expect(WorkerProviderError.isCleanupIndeterminate(error)).toBe(true);
    expect(error).toMatchObject({
      leaseId: params.inspect.id,
      provisionError: original,
      cleanupError,
    });
  });
});

describe("Crabbox setup profile authority", () => {
  it.each([true, false])(
    "rejects closed authority before profile effects (forwarded environment: %s)",
    async (forwardEnvironment) => {
      const { params, revoke, authorityError } = createSetupFixture();
      revoke();
      const error = await runProvisionSetup({
        ...params,
        forwardedEnv: forwardEnvironment ? params.forwardedEnv : undefined,
      }).catch((cause: unknown) => cause);

      expect(error).toMatchObject({ message: "worker turn authority changed" });
      expect(error).toBe(authorityError);
      expect(params.stopLease).toHaveBeenCalledOnce();
      expect(params.runCommand).not.toHaveBeenCalled();
      expect(fs.mkdtemp).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    },
  );

  it.each(["directory creation", "profile write"] as const)(
    "rechecks authority after awaited %s and removes the temporary profile",
    async (boundary) => {
      const { params, revoke, authorityError } = createSetupFixture();
      const directory = tempDirs.make("crabbox-setup-authority-");
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      vi.mocked(fs.mkdtemp).mockImplementationOnce(async () => {
        if (boundary === "directory creation") {
          entered.resolve();
          await resume.promise;
        }
        return directory;
      });
      if (boundary === "profile write") {
        const actual = await vi.importActual<typeof fs>("node:fs/promises");
        vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
          await actual.writeFile(...args);
          entered.resolve();
          await resume.promise;
        });
      }
      const pending = runProvisionSetup(params).catch((cause: unknown) => cause);
      try {
        await entered.promise;
        // Hold the real profile lifecycle across revocation, not an authorization call count.
        expect(params.runCommand).not.toHaveBeenCalled();
        if (boundary === "profile write") {
          expect(await fs.readFile(join(directory, "setup.env"), "utf8")).toContain(
            'WORKER_ARTIFACT_TOKEN="fixture-artifact-value"',
          );
        }
        revoke();
      } finally {
        resume.resolve();
        await pending;
      }

      expect(await pending).toMatchObject({ message: "worker turn authority changed" });
      expect(await pending).toBe(authorityError);
      expect(params.runCommand).not.toHaveBeenCalled();
      expect(params.stopLease).toHaveBeenCalledOnce();
      await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      if (boundary === "directory creation") {
        expect(fs.writeFile).not.toHaveBeenCalled();
      }
    },
  );

  it("rechecks authority after the setup command settles", async () => {
    const { params, revoke, authorityError } = createSetupFixture();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    params.runCommand.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    const pending = runProvisionSetup(params).catch((cause: unknown) => cause);
    await entered.promise;
    revoke();
    resume.resolve();

    const error = await pending;
    expect(error).toMatchObject({ message: "worker turn authority changed" });
    expect(error).toBe(authorityError);
    expect(params.stopLease).toHaveBeenCalledOnce();
  });
});
