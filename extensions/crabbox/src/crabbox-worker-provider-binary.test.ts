import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  commandResult,
  createProviderFixtures,
  OPENCLAW_ROOT,
} from "./crabbox-worker-provider.test-support.js";

vi.mock("./crabbox-managed-binary.js", () => ({
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
});

describe("Crabbox provider binary resolution", () => {
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
    const provider = createProvider({ runCommand });
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

  it("reports fallbacks only for an explicitly configured binary", async () => {
    const warn = vi.fn();
    const runCommand = vi.fn<CrabboxCommandRunner>(async () => commandResult({ stdout: "[]" }));
    const provider = createProvider({ runCommand, warn });

    await provider.listMachineOptions!(PROFILE);
    const implicit = vi.mocked(ensureManagedCrabboxBinary).mock.calls.at(-1)![0]!;
    expect(implicit).toMatchObject({ binary: SIBLING_BINARY });
    expect("warn" in implicit).toBe(false);

    await provider.listMachineOptions!({ ...PROFILE, binary: "/opt/other/crabbox" });
    expect(ensureManagedCrabboxBinary).toHaveBeenLastCalledWith(
      expect.objectContaining({ binary: "/opt/other/crabbox", warn }),
    );
  });
});
