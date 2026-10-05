import { describe, expect, it, vi } from "vitest";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import {
  inspectJson,
  lifecycleLease,
  providerWithRunner,
  LEASE_ID,
} from "./crabbox-worker-provider-fixture.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";

vi.mock("./crabbox-managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crabbox-managed-binary.js")>()),
  ensureManagedCrabboxBinary: vi.fn(),
}));
const lease = lifecycleLease(LEASE_ID, {
  provider: "azure-sandbox",
  class: "standard",
  warmImage: false,
  ttl: "24h",
  idleTimeout: "60m",
});

describe("Sandbox dormant lease observation and wake", () => {
  it.each(["Stopped", "Suspended", "Idle", "Resuming", "Disabled", "Failed", "Deleting", "future"])(
    "inspects %s without executing, replacing or deleting the lease",
    async (state) => {
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return commandResult({ stdout: inspectJson({ state }) });
      });
      expect(await provider.inspect(lease)).toEqual({
        status: ["Stopped", "Suspended", "Idle", "Resuming"].includes(state)
          ? "dormant"
          : "unknown",
      });
      expect(calls.every((argv) => argv[1] === "inspect")).toBe(true);
    },
  );

  it.each(["current", "revoked", "cancelled", "execution rejected"] as const)(
    "uses the existing exact-ID guarded execution and paired node owner: %s",
    async (state) => {
      const controller = new AbortController();
      let current = true;
      const commands: Array<{ argv: string[]; input?: string | Uint8Array }> = [];
      const provider = providerWithRunner(async (argv, options) => {
        commands.push({ argv, input: options.input });
        if (state === "revoked") {
          current = false;
        }
        if (state === "cancelled") {
          controller.abort();
        }
        return commandResult(
          state === "execution rejected" ? { code: 1, stderr: "lease disabled" } : {},
        );
      });
      const waitForDeviceId = vi.fn(async () => "original-device");
      const beginNodeEnrollment = vi.fn(async () => ({
        mode: "resume" as const,
        deviceId: "original-device",
        displayName: "Original worker",
        openclawVersion: "2026.8.1",
        nodeBootstrap: createNodeBootstrapFixture(),
        waitForDeviceId,
      }));
      if (!provider.resume) {
        throw new Error("Provider lacks the selected resume contract");
      }
      const waking = provider.resume(lease, {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("caller closed");
          }
        },
        beginNodeEnrollment,
      });
      if (state === "current") {
        await waking;
        expect(waitForDeviceId).toHaveBeenCalledOnce();
        expect(commands).toHaveLength(2);
      } else {
        await expect(waking).rejects.toThrow();
        expect(beginNodeEnrollment).toHaveBeenCalledOnce();
        expect(commands).toHaveLength(1);
      }
      for (const { argv } of commands) {
        expect(argv[1]).toBe("run");
        expect(argv[argv.indexOf("--id") + 1]).toBe(LEASE_ID);
        expect(argv).toContain("--keep=true");
        expect(argv).toContain("--no-sync");
        expect(argv).not.toContain("--ttl");
      }
      expect(commands[0]?.input).toBe("true\n");
    },
  );

  it("leaves non-Sandbox profiles with their existing reconnection owner", async () => {
    const runCommand = vi.fn(async () => commandResult());
    const provider = providerWithRunner(runCommand);
    const beginNodeEnrollment = vi.fn();
    if (!provider.resume) {
      throw new Error("Provider lacks the selected resume contract");
    }
    await expect(
      provider.resume(
        { ...lease, profile: { ...lease.profile, provider: "aws" } },
        {
          signal: new AbortController().signal,
          assertCurrent: () => {},
          beginNodeEnrollment,
        },
      ),
    ).resolves.toBe("unsupported");
    expect(beginNodeEnrollment).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
