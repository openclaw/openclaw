import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: vi.mock hoists above imports. The dynamic import() in beforeEach
// ensures promisify(execFile) wraps the mock. Do NOT change to static imports.
//
// IMPORTANT: promisify(vi.fn()) does NOT inherit Node's util.promisify.custom
// from the real execFile. Standard promisify resolves with the first non-error
// callback arg. For rewrite calls, we must pass {stdout, stderr} as that first
// arg so that `const { stdout } = await execFileAsync(...)` destructures correctly.
// Detection calls don't use the resolved value, so their format doesn't matter.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

describe("rtk-rewrite", () => {
  let execFileMock: Mock;
  let tryRtkRewrite: typeof import("./rtk-rewrite.js").tryRtkRewrite;
  let initRtkDetection: typeof import("./rtk-rewrite.js").initRtkDetection;
  let resetRtkDetection: typeof import("./rtk-rewrite.js").resetRtkDetection;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const childProcess = await import("node:child_process");
    execFileMock = childProcess.execFile as unknown as Mock;

    ({ tryRtkRewrite, initRtkDetection, resetRtkDetection } = await import("./rtk-rewrite.js"));
  });

  describe("initRtkDetection / detection caching", () => {
    it("detects rtk when binary is present", async () => {
      // First call: detection (rtk --version) — result is not used, just must not throw.
      // Second call: rewrite — promisify resolves with first arg, so pass {stdout, stderr}.
      execFileMock
        .mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, "rtk 1.0.0", "");
        })
        .mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, { stdout: "rtk rewritten cmd", stderr: "" });
        });

      initRtkDetection();
      await new Promise((r) => setTimeout(r, 0));

      const result = await tryRtkRewrite("ls -la");
      expect(result).toBe("rtk rewritten cmd");
    });

    it("marks rtk unavailable when binary is missing", async () => {
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(new Error("not found"), "", "");
        },
      );

      initRtkDetection();
      await new Promise((r) => setTimeout(r, 0));

      const result = await tryRtkRewrite("ls -la");
      expect(result).toBeNull();
      // execFile called once (for detection), never for rewrite
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("tryRtkRewrite", () => {
    beforeEach(async () => {
      // Ensure rtk is marked as available via detection.
      // Detection result is not used — format doesn't matter, just must not throw.
      execFileMock.mockImplementationOnce(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, "rtk 1.0.0", "");
        },
      );
      initRtkDetection();
      await new Promise((r) => setTimeout(r, 0));
    });

    it("returns rewritten command when rtk produces different output", async () => {
      // Rewrite calls: promisify resolves with first arg → pass {stdout, stderr}
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, { stdout: "rtk rewrite result\n", stderr: "" });
        },
      );

      const result = await tryRtkRewrite("git log --oneline -20");
      expect(result).toBe("rtk rewrite result");
    });

    it("returns null when rtk output equals input (no rewrite needed)", async () => {
      const cmd = "echo hello";
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, { stdout: cmd, stderr: "" });
        },
      );

      const result = await tryRtkRewrite(cmd);
      expect(result).toBeNull();
    });

    it("returns null when rtk exits with error (exit code 1 = no rewrite)", async () => {
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          const err = new Error("Command failed");
          cb(err, "", "");
        },
      );

      const result = await tryRtkRewrite("ls -la");
      expect(result).toBeNull();
    });

    it("returns null on timeout — graceful degradation", async () => {
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          const err = Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
          cb(err, "", "");
        },
      );

      const result = await tryRtkRewrite("cat /var/log/syslog");
      expect(result).toBeNull();
    });

    it("returns null when rtk output is empty", async () => {
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, { stdout: "", stderr: "" });
        },
      );

      const result = await tryRtkRewrite("ls");
      expect(result).toBeNull();
    });

    it("passes the exact command string to rtk as an argument", async () => {
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, { stdout: "rewritten", stderr: "" });
        },
      );

      const cmd = 'git log --format="%H %s" --since="2 weeks ago"';
      await tryRtkRewrite(cmd);

      expect(execFileMock).toHaveBeenCalledWith(
        "rtk",
        ["rewrite", cmd],
        expect.objectContaining({ timeout: 2000 }),
        expect.any(Function),
      );
    });
  });

  describe("resetRtkDetection", () => {
    it("clears cached detection so re-detection can occur", async () => {
      // First detection: rtk present
      execFileMock.mockImplementationOnce(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, "rtk 1.0.0", "");
        },
      );
      initRtkDetection();
      await new Promise((r) => setTimeout(r, 0));

      // Reset + re-detect with rtk absent
      resetRtkDetection();
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(new Error("not found"), "", "");
        },
      );

      initRtkDetection();
      await new Promise((r) => setTimeout(r, 0));

      const result = await tryRtkRewrite("ls");
      expect(result).toBeNull();
    });

    it("is a no-op safe to call multiple times", () => {
      expect(() => {
        resetRtkDetection();
        resetRtkDetection();
      }).not.toThrow();
    });
  });
});
