// Unit tests for the fail-closed dependency probe (S5 Linux gate, AC-L1 / AC-L6).
//
// The probe is the single gate the backend factory awaits before it constructs
// a scope (backend.ts createSrtSandboxBackendFactory), so these assertions also
// prove the "no command executes unsandboxed" guarantee: when the probe throws,
// the factory rejects and never returns a handle that could run a command.
//
// SandboxManager is stubbed so both outcomes (deps present / deps missing) and
// the platform gate can be exercised on any host — the LIVE bwrap-present path
// is proven separately on a real Linux host (backend.linux.test.ts, AC-L2..L6).
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSrtSandboxBackendFactory, SRT_SANDBOX_BACKEND_ID } from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { assertSrtSandboxAvailable, SrtSandboxUnavailableError } from "./dependency-probe.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function stubSrt(opts: { supported: boolean; errors?: string[]; warnings?: string[] }): void {
  vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(opts.supported);
  vi.spyOn(SandboxManager, "checkDependenciesAsync").mockResolvedValue({
    errors: opts.errors ?? [],
    warnings: opts.warnings ?? [],
  } as Awaited<ReturnType<typeof SandboxManager.checkDependenciesAsync>>);
}

describe("srt dependency probe (fail-closed gate)", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  it("AC-L1: passes on Linux when bwrap/socat/ripgrep/seccomp are all present", async () => {
    setPlatform("linux");
    stubSrt({ supported: true, errors: [], warnings: [] });
    await expect(assertSrtSandboxAvailable()).resolves.toBeUndefined();
  });

  it("AC-L1: fails closed on Linux with actionable install guidance when bwrap is missing", async () => {
    setPlatform("linux");
    stubSrt({ supported: true, errors: ["bubblewrap (bwrap) not installed"] });
    const err = await assertSrtSandboxAvailable().catch((e) => e);
    expect(err).toBeInstanceOf(SrtSandboxUnavailableError);
    expect(err.message).toContain("bubblewrap (bwrap) not installed");
    // Actionable: names the package and an install command, and states fail-closed.
    expect(err.message).toMatch(/apt-get install[^.]*bubblewrap/);
    expect(err.message).toMatch(/dnf install[^.]*bubblewrap/);
    expect(err.message).toMatch(/fail-closed/i);
  });

  it("AC-L1: aggregates every missing dependency into the guidance package list", async () => {
    setPlatform("linux");
    stubSrt({
      supported: true,
      errors: ["bubblewrap (bwrap) not installed", "socat not installed", "ripgrep (rg) not found"],
    });
    const err = await assertSrtSandboxAvailable().catch((e) => e);
    expect(err.message).toMatch(/apt-get install bubblewrap ripgrep socat/);
  });

  it("AC-L1: the factory never yields a handle when the probe fails (no unsandboxed exec)", async () => {
    setPlatform("linux");
    stubSrt({ supported: true, errors: ["bubblewrap (bwrap) not installed"] });
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    await expect(
      factory({
        sessionKey: "s",
        scopeKey: "scope",
        workspaceDir: "/tmp/nope",
        agentWorkspaceDir: "/tmp/nope-agent",
        cfg: {
          mode: "all",
          backend: SRT_SANDBOX_BACKEND_ID,
          scope: "session",
          workspaceAccess: "rw",
          workspaceRoot: "/tmp/nope",
          dockerTmpfsSource: "default",
          docker: { workdir: "/tmp/nope", env: {} },
          ssh: {},
          browser: {},
          tools: {},
          prune: {},
        },
      } as Parameters<typeof factory>[0]),
    ).rejects.toThrow(SrtSandboxUnavailableError);
  });

  it("AC-L6: promotes a missing-seccomp warning to a fail-closed error on Linux", async () => {
    setPlatform("linux");
    stubSrt({
      supported: true,
      errors: [],
      warnings: ["seccomp not available - unix socket access not restricted"],
    });
    const err = await assertSrtSandboxAvailable().catch((e) => e);
    expect(err).toBeInstanceOf(SrtSandboxUnavailableError);
    expect(err.message).toMatch(/seccomp helper unavailable/);
    expect(err.message).toMatch(/@anthropic-ai\/sandbox-runtime@0\.0\.76/);
  });

  it("does not treat the seccomp warning as fatal on macOS (Seatbelt has no seccomp helper)", async () => {
    setPlatform("darwin");
    stubSrt({
      supported: true,
      errors: [],
      warnings: ["seccomp not available - unix socket access not restricted"],
    });
    await expect(assertSrtSandboxAvailable()).resolves.toBeUndefined();
  });

  it("fails closed on Windows with an S6 not-yet-enabled message", async () => {
    setPlatform("win32");
    // isSupportedPlatform is never reached; the platform gate rejects first.
    const err = await assertSrtSandboxAvailable().catch((e) => e);
    expect(err).toBeInstanceOf(SrtSandboxUnavailableError);
    expect(err.message).toMatch(/Windows/);
    expect(err.message).toMatch(/S6/);
  });
});
