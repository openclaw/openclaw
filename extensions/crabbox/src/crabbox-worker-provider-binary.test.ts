import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  commandResult,
  createProviderTestHarness,
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
const actual = await vi.importActual<typeof import("./crabbox-managed-binary.js")>(
  "./crabbox-managed-binary.js",
);
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
const { createProvider, tempDirs } = createProviderTestHarness({
  isExecutable: (candidate) => candidate === SIBLING_BINARY,
});
const binaryResult = { binary: SIBLING_BINARY, version: "999.0.0" };
function fixture(command: CrabboxCommandRunner = async () => commandResult({ stdout: "[]" })) {
  const runCommand = vi.fn(command);
  const warn = vi.fn<(message: string) => void>();
  return { runCommand, warn, provider: createProvider({ runCommand, warn }) };
}
function heldAcquisition(command?: CrabboxCommandRunner) {
  const started = createDeferred<AbortSignal>();
  const finish = createDeferred<CrabboxBinary>();
  vi.mocked(ensureManagedCrabboxBinary).mockImplementation((params) => {
    started.resolve(params!.signal!);
    return finish.promise;
  });
  return { ...fixture(command), started, finish };
}

it.each([
  ["current", commandResult({ stdout: "crabbox 999.0.0" }), "", true],
  [
    "indeterminate",
    commandResult({ termination: "timeout", code: null }),
    "timed out after 30000 ms",
    true,
  ],
  [
    "indeterminate",
    new Error(`token=synthetic-version-secret-0123456789 ${"failure ".repeat(100)}`),
    "execution failed",
    false,
  ],
] as const)(
  "shares discovery and reports an explicit %s candidate (%#)",
  async (status, probe, reason, joinInFlight) => {
    vi.mocked(ensureManagedCrabboxBinary).mockImplementation(actual.ensureManagedCrabboxBinary);
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-fallback-"));
    const managed = actual.resolveManagedCrabboxBinaryPath();
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, "fixture");
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const { provider, runCommand, warn } = fixture(async ([binary, command]) => {
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
    const implicit = Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        index % 2 === 0
          ? provider.listMachineOptions!(PROFILE)
          : provider.listOperatingSystems!(PROFILE),
      ),
    );
    await started.promise;
    const explicitProfile = { ...PROFILE, binary: SIBLING_BINARY };
    const joined = joinInFlight ? provider.listOperatingSystems!(explicitProfile) : undefined;
    try {
      expect(runCommand.mock.calls.filter(([argv]) => argv[1] === "--version")).toHaveLength(1);
    } finally {
      finish.resolve();
      await implicit;
    }
    if (!joinInFlight) {
      expect(warn).not.toHaveBeenCalled();
    }
    await (joined ?? provider.listOperatingSystems!(explicitProfile));
    await provider.listMachineOptions!(explicitProfile);

    expect(ensureManagedCrabboxBinary).toHaveBeenCalledOnce();
    if (status === "current") {
      await provider.listOperatingSystems!({ ...PROFILE, binary: "/opt/other/crabbox" });
      expect(runCommand.mock.calls.map(([argv]) => argv.slice(0, 2))).toEqual([
        [SIBLING_BINARY, "--version"],
        [SIBLING_BINARY, "providers"],
        ["/opt/other/crabbox", "--version"],
        ["/opt/other/crabbox", "providers"],
      ]);
      expect(warn).not.toHaveBeenCalled();
      return;
    }
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0];
    expect(message).toContain(`configured binary "${SIBLING_BINARY}"`);
    expect(message).toContain(`probe status "${status}"`);
    expect(message).toContain(reason);
    expect(message).toContain(`using managed binary "${managed}"`);
    expect(message).not.toContain("synthetic-version-secret");
    const detail = message.split('probe status "indeterminate": ')[1]!.split("); using")[0]!;
    expect(detail.length).toBeLessThanOrEqual(201);
  },
);

it("evicts a shared rejection so later discovery can retry", async () => {
  const failure = new Error("version probe unavailable");
  vi.mocked(ensureManagedCrabboxBinary).mockRejectedValueOnce(failure);
  const { provider, runCommand } = fixture();
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
    const { provider, runCommand, started, finish } = heldAcquisition();
    const controller = new AbortController();
    let discovery: Promise<unknown> | undefined;
    if (waiter === "joining") {
      discovery = provider.listMachineOptions!(PROFILE);
    }
    const beginNodeEnrollment = vi.fn();
    const preparation = provider.provision(PROFILE, `provision:v2:${"0".repeat(64)}`, {
      assertCurrent() {},
      beginNodeEnrollment,
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
      expect(beginNodeEnrollment).not.toHaveBeenCalled();
    } finally {
      finish.resolve(binaryResult);
      await discovery;
    }
    expect(ensureManagedCrabboxBinary).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(["providers"]);
  },
);

it("aborts and drains shared acquisition on provider disposal", async () => {
  const { provider, runCommand, started, finish } = heldAcquisition(vi.fn<CrabboxCommandRunner>());
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
    finish.resolve(binaryResult);
    await rejected;
    await stopping;
  }
  expect(stopped).toBe(true);
  await expect(provider.listOperatingSystems!(PROFILE)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(runCommand).not.toHaveBeenCalled();
});
