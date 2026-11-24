import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanBeamCandidate, type BeamCleanCandidate } from "./cleaner.js";

const resolveExecutable = vi.fn<() => Promise<string>>();
vi.mock("openclaw/plugin-sdk/process-runtime", async (load) => {
  const actual = await load<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return { ...actual, runCommandBuffered: vi.fn(actual.runCommandBuffered) };
});

const candidate: BeamCleanCandidate = {
  source: "openclaw",
  origin: { adapter: "openclaw", sourceHome: "private-home", nativeSession: "private-session" },
  title: "Test",
  updatedAt: "2026-01-01T00:00:00Z",
  completed: false,
  completeness: "complete",
  items: [{ type: "userMessage", text: "hello", speakerId: "private-person" }],
};

const snapshot =
  JSON.stringify(
    {
      version: 2,
      beamId: "a".repeat(32),
      source: "openclaw",
      title: "Test",
      updatedAt: candidate.updatedAt,
      completed: false,
      items: [{ type: "userMessage", text: "hello", speaker: "p1" }],
    },
    undefined,
    2,
  ) + "\n";

// Substitute only the process entrypoint; stdin, byte caps, cancellation and
// exit handling use the production SDK's subprocess runner on every platform.
async function fixture(body: string) {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/process-runtime")>(
    "openclaw/plugin-sdk/process-runtime",
  );
  resolveExecutable.mockResolvedValue(process.execPath);
  vi.mocked(runCommandBuffered).mockImplementation(([exe, ...args], options) => {
    expect([exe, ...args]).toEqual([process.execPath, "clean", "--protocol", "1"]);
    return actual.runCommandBuffered([process.execPath, "-e", body, "--", ...args], options);
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("packaged Beam cleaner", () => {
  it.runIf(process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT)(
    "cleans a selected conversation using the installed and verified native package",
    async () => {
      const { createBeamExecutableResolver } = await import("./executable.js");
      const runtime = await vi.importActual<typeof import("openclaw/plugin-sdk/process-runtime")>(
        "openclaw/plugin-sdk/process-runtime",
      );
      vi.mocked(runCommandBuffered).mockImplementation(runtime.runCommandBuffered);
      const { raw, packet } = await cleanBeamCandidate(
        JSON.stringify(candidate),
        new AbortController().signal,
        createBeamExecutableResolver(process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT!),
      );
      expect(packet.items).toEqual([{ type: "userMessage", text: "hello", speaker: "p1" }]);
      expect(raw.toString()).not.toContain("private-");
    },
  );

  it("passes selected history on stdin, excludes host credentials and preserves reviewed bytes", async () => {
    vi.stubEnv("BEAM_SYNTHETIC_PRIVATE_ENV", "private-value");
    await fixture(`
      let src = "";
      process.stdin.setEncoding("utf8").on("data", (part) => src += part);
      process.stdin.on("end", () => {
        if (process.env.BEAM_SYNTHETIC_PRIVATE_ENV || JSON.parse(src).origin.nativeSession !== "private-session") {
          process.exitCode = 3;
        } else {
          process.stdout.write(${JSON.stringify(snapshot)});
        }
      });
    `);
    const result = await cleanBeamCandidate(
      JSON.stringify(candidate),
      new AbortController().signal,
      resolveExecutable,
    );
    expect(result.raw.equals(Buffer.from(snapshot))).toBe(true);
    expect(result.packet.items).toEqual([{ type: "userMessage", text: "hello", speaker: "p1" }]);
  });

  it.each([
    ['process.stderr.write("private diagnostic");process.exitCode = 2', "Beam cleaner failed"],
    ['process.stdout.write("{private transcript")', "invalid Beam v2 packet"],
    ['process.stdout.write("x".repeat(56 * 1024 + 1))', "output-limit"],
  ])("rejects failed or invalid child output", async (script, expected) => {
    await fixture(script);
    const error: unknown = await cleanBeamCandidate(
      JSON.stringify(candidate),
      new AbortController().signal,
      resolveExecutable,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain("private");
  });

  it("rejects oversized input before resolving the executable", async () => {
    const large = { ...candidate, title: "x".repeat(4 * 1024 * 1024) };
    await expect(
      cleanBeamCandidate(JSON.stringify(large), new AbortController().signal, resolveExecutable),
    ).rejects.toThrow("4 MiB");
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("stops a pending native clean when its service is deactivated", async () => {
    await fixture("process.stdin.resume();setInterval(() => {}, 1000)");
    const signal = AbortSignal.timeout(100);
    await expect(
      cleanBeamCandidate(JSON.stringify(candidate), signal, resolveExecutable),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(runCommandBuffered).toHaveBeenCalledOnce();
  });
});
