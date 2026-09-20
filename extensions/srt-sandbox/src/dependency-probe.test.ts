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
import { SandboxManager, checkWindowsDependenciesAsync } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSrtSandboxBackendFactory, SRT_SANDBOX_BACKEND_ID } from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { assertSrtSandboxAvailable, SrtSandboxUnavailableError } from "./dependency-probe.js";

// ESM function exports can't be spied in place; mock just the Windows probe fn
// (everything else passes through so the SandboxManager spies below still work).
vi.mock("@anthropic-ai/sandbox-runtime", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sandbox-runtime")>();
  return { ...actual, checkWindowsDependenciesAsync: vi.fn() };
});
const mockCheckWindows = vi.mocked(checkWindowsDependenciesAsync);

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

  it("AC-R3 (B2): fails the FACTORY closed when the seccomp helper is unresolvable — no handle, no unsandboxed exec", async () => {
    // SRT reports a missing/unresolvable vendored apply-seccomp as this exact
    // degraded warning (linux-sandbox-utils checkLinuxDependencies). The probe
    // promotes it to a hard error on Linux; the factory awaits that probe before
    // it constructs a scope, so a seccomp-degraded host must never receive a
    // handle it could run a command through outside kernel-enforced seccomp.
    setPlatform("linux");
    stubSrt({
      supported: true,
      errors: [],
      warnings: ["seccomp not available - unix socket access not restricted"],
    });
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const create = factory({
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
    } as Parameters<typeof factory>[0]);
    // The factory rejects (fail-closed) and yields no handle …
    await expect(create).rejects.toThrow(SrtSandboxUnavailableError);
    // … and the rejection is specifically the seccomp promotion, not some other
    // dependency gap, so the guarantee is anchored to the missing helper.
    await expect(create).rejects.toThrow(/seccomp helper unavailable/);
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

  it("S6: passes on Windows when the srt-win dependencies are present", async () => {
    setPlatform("win32");
    mockCheckWindows.mockResolvedValue({ errors: [], warnings: [] });
    const srtWin = { exe: "C:\\srt-win.exe", prependArgs: ["--srt-win"] as const };
    await expect(assertSrtSandboxAvailable(srtWin)).resolves.toBeUndefined();
  });

  it("S6: fails closed on Windows when the srt-win toolchain is unusable", async () => {
    setPlatform("win32");
    mockCheckWindows.mockResolvedValue({ errors: ["srt-win.exe not found"], warnings: [] });
    const srtWin = { exe: "C:\\srt-win.exe", prependArgs: ["--srt-win"] as const };
    const err = await assertSrtSandboxAvailable(srtWin).catch((e) => e);
    expect(err).toBeInstanceOf(SrtSandboxUnavailableError);
    expect(err.message).toMatch(/Windows/);
    expect(err.message).toMatch(/fail-closed/i);
  });
});
