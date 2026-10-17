import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  commandResult,
  createProviderFixtures,
  OPENCLAW_ROOT,
} from "./crabbox-worker-provider.test-support.js";

vi.mock("./crabbox-managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crabbox-managed-binary.js")>()),
  ensureManagedCrabboxBinary: vi.fn(),
}));

const PROFILE = {
  provider: "aws",
  class: "standard",
  ttl: "24h",
  idleTimeout: "60m",
  warmImage: false,
};
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
const { providers, createProvider } = createProviderFixtures({
  isExecutable: (candidate) => candidate === SIBLING_BINARY,
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.mocked(ensureManagedCrabboxBinary)
    .mockReset()
    .mockImplementation(async (params) => ({
      binary: params?.binary ?? "crabbox",
      version: "999.0.0",
    }));
});
afterEach(async () => {
  await Promise.all([...providers].map((provider) => provider.dispose()));
  providers.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  syncBuiltinESMExports();
});

describe("Crabbox provider binary resolution", () => {
  it.each([
    ["outdated", commandResult({ stdout: "crabbox 0.66.0" }), "version 0.66.0", false],
    [
      "indeterminate",
      commandResult({ termination: "timeout", code: null }),
      "timed out after 30000 ms",
      true,
    ],
    [
      "indeterminate",
      commandResult({ stdout: "not-a-version" }),
      "version output was not recognized",
      false,
    ],
    [
      "indeterminate",
      new Error(`token=synthetic-version-secret-0123456789 ${"failure ".repeat(100)}`),
      "execution failed",
      false,
    ],
  ] as const)(
    "warns once for an explicit %s candidate after shared discovery (%#)",
    async (status, probe, reason, joinInFlight) => {
      const actual = await vi.importActual<typeof import("./crabbox-managed-binary.js")>(
        "./crabbox-managed-binary.js",
      );
      vi.mocked(ensureManagedCrabboxBinary).mockImplementation(actual.ensureManagedCrabboxBinary);
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-fallback-"));
      const managed = actual.resolveManagedCrabboxBinaryPath();
      await fs.mkdir(path.dirname(managed), { recursive: true });
      await fs.writeFile(managed, "fixture");
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const warn = vi.fn<(message: string) => void>();
      const runCommand = vi.fn<CrabboxCommandRunner>(async ([binary, command]) => {
        if (command !== "--version") {
          return commandResult({ stdout: "[]" });
        }
        if (binary === managed) {
          return commandResult({ stdout: `crabbox ${actual.CRABBOX_MIN_VERSION}` });
        }
        started.resolve();
        await finish.promise;
        if (probe instanceof Error) {
          throw probe;
        }
        return probe;
      });
      const provider = createProvider({ runCommand, warn });
      const implicit = provider.listMachineOptions!(PROFILE);
      await started.promise;
      const explicitProfile = { ...PROFILE, binary: SIBLING_BINARY };
      const joined = joinInFlight ? provider.listOperatingSystems!(explicitProfile) : undefined;
      finish.resolve();
      await implicit;
      if (!joinInFlight) {
        expect(warn).not.toHaveBeenCalled();
      }
      await (joined ?? provider.listOperatingSystems!(explicitProfile));
      await provider.listMachineOptions!(explicitProfile);

      expect(warn).toHaveBeenCalledOnce();
      const message = warn.mock.calls[0]![0];
      expect(message).toContain(`configured binary "${SIBLING_BINARY}"`);
      expect(message).toContain(`probe status "${status}"`);
      expect(message).toContain(reason);
      expect(message).toContain(`using managed binary "${managed}"`);
      expect(message).not.toContain("synthetic-version-secret");
      if (status === "outdated") {
        expect(message).toContain(`required ${actual.CRABBOX_MIN_VERSION}`);
      } else {
        const detail = message.split('probe status "indeterminate": ')[1]!.split("); using")[0]!;
        expect(detail.length).toBeLessThanOrEqual(201);
      }
      expect(ensureManagedCrabboxBinary).toHaveBeenCalledOnce();
    },
  );

  it("coalesces concurrent discovery into one version probe per binary", async () => {
    const actual = await vi.importActual<typeof import("./crabbox-managed-binary.js")>(
      "./crabbox-managed-binary.js",
    );
    vi.mocked(ensureManagedCrabboxBinary).mockImplementation(actual.ensureManagedCrabboxBinary);
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const runCommand = vi.fn<CrabboxCommandRunner>(async (argv) => {
      if (argv[1] === "--version") {
        started.resolve();
        await finish.promise;
        return commandResult({ stdout: "crabbox 999.0.0" });
      }
      return commandResult({ stdout: "[]" });
    });
    const warn = vi.fn();
    const provider = createProvider({ runCommand, warn });
    const discoveries = Array.from({ length: 6 }, (_, index) =>
      index % 2 === 0
        ? provider.listMachineOptions!(PROFILE)
        : provider.listOperatingSystems!(PROFILE),
    );
    try {
      await started.promise;
      expect(runCommand.mock.calls.filter(([argv]) => argv[1] === "--version")).toHaveLength(1);
    } finally {
      finish.resolve();
      await Promise.all(discoveries);
    }
    await provider.listMachineOptions!(PROFILE);
    await provider.listOperatingSystems!({ ...PROFILE, binary: "/opt/other/crabbox" });
    expect(runCommand.mock.calls.map(([argv]) => argv.slice(0, 2))).toEqual([
      [SIBLING_BINARY, "--version"],
      [SIBLING_BINARY, "providers"],
      ["/opt/other/crabbox", "--version"],
      ["/opt/other/crabbox", "providers"],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("evicts a shared rejection so later discovery can retry", async () => {
    const failure = new Error("version probe unavailable");
    vi.mocked(ensureManagedCrabboxBinary).mockRejectedValueOnce(failure);
    const runCommand = vi.fn<CrabboxCommandRunner>(async () => commandResult({ stdout: "[]" }));
    const provider = createProvider({ runCommand });
    const results = await Promise.allSettled([
      provider.listMachineOptions!(PROFILE),
      provider.listOperatingSystems!(PROFILE),
    ]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(ensureManagedCrabboxBinary).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
    await provider.listMachineOptions!(PROFILE);
    expect(ensureManagedCrabboxBinary).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it.each(["first", "joining"] as const)(
    "cancels the %s waiter without cancelling shared acquisition",
    async (waiter) => {
      const started = createDeferred<AbortSignal>();
      const finish = createDeferred<CrabboxBinary>();
      vi.mocked(ensureManagedCrabboxBinary).mockImplementation((params) => {
        started.resolve(params!.signal!);
        return finish.promise;
      });
      const runCommand = vi.fn<CrabboxCommandRunner>(async () => commandResult({ stdout: "[]" }));
      const provider = createProvider({ runCommand });
      const controller = new AbortController();
      let discovery: Promise<unknown> | undefined;
      if (waiter === "joining") {
        discovery = provider.listMachineOptions!(PROFILE);
      }
      const preparation = provider.prepareProvision!(PROFILE, "cancelled", {
        assertCurrent() {},
        signal: controller.signal,
      });
      const rejected = expect(preparation).rejects.toMatchObject({ name: "AbortError" });
      try {
        const signal = await started.promise;
        discovery ??= provider.listOperatingSystems!(PROFILE);
        controller.abort();
        await rejected;
        expect(signal.aborted).toBe(false);
        expect(runCommand).not.toHaveBeenCalled();
      } finally {
        finish.resolve({ binary: SIBLING_BINARY, version: "999.0.0" });
        await discovery;
      }
      expect(ensureManagedCrabboxBinary).toHaveBeenCalledOnce();
      expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(["providers"]);
    },
  );

  it("aborts and drains shared acquisition on provider disposal", async () => {
    const started = createDeferred<AbortSignal>();
    const finish = createDeferred<CrabboxBinary>();
    vi.mocked(ensureManagedCrabboxBinary).mockImplementation((params) => {
      started.resolve(params!.signal!);
      return finish.promise;
    });
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = createProvider({ runCommand });
    const discovery = provider.listMachineOptions!(PROFILE);
    const rejected = expect(discovery).rejects.toMatchObject({ name: "AbortError" });
    const signal = await started.promise;
    let stopped = false;
    const stopping = provider.dispose().then(() => {
      stopped = true;
    });
    try {
      expect(signal.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      finish.resolve({ binary: SIBLING_BINARY, version: "999.0.0" });
      await rejected;
      await stopping;
    }
    expect(stopped).toBe(true);
    await expect(provider.listOperatingSystems!(PROFILE)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
