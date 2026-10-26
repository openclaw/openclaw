import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./progress-line.js", () => ({
  clearActiveProgressLine: vi.fn(),
}));

import { restoreTerminalState } from "./restore.js";

type Stdin = Partial<Pick<NodeJS.ReadStream, "setRawMode" | "resume" | "isPaused">>;
function configureTerminalIO(stdinIsTTY: boolean, stdoutIsTTY: boolean, methods: Stdin = {}) {
  Object.defineProperty(process.stdin, "isTTY", { value: stdinIsTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTTY, configurable: true });
  Object.assign(process.stdin, methods);
}

describe("restoreTerminalState", () => {
  const { isTTY: stdinIsTTY, setRawMode, resume, isPaused } = process.stdin;
  const stdoutIsTTY = process.stdout.isTTY;

  afterEach(() => {
    vi.restoreAllMocks();
    configureTerminalIO(stdinIsTTY, stdoutIsTTY, { setRawMode, resume, isPaused });
  });

  it.each([
    ["leaves paused stdin alone by default", true, undefined, 0],
    ["resumes paused TTY stdin when requested", true, true, 1],
    ["does not touch non-TTY stdin", false, true, 0],
  ] as const)("%s", (_label, tty, resumeStdinIfPaused, resumeCalls) => {
    const stdin = {
      setRawMode: vi.fn(() => process.stdin),
      resume: vi.fn(() => process.stdin),
      isPaused: () => true,
    };
    configureTerminalIO(tty, false, stdin);
    restoreTerminalState("test", { resumeStdinIfPaused });
    if (tty) {
      expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    } else {
      expect(stdin.setRawMode).not.toHaveBeenCalled();
    }
    expect(stdin.resume).toHaveBeenCalledTimes(resumeCalls);
  });

  it("writes kitty and modifyOtherKeys reset sequences to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    configureTerminalIO(false, true);
    restoreTerminalState("test");

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("\x1b[<u");
    expect(output).toContain("\x1b[>4;0m");
  });

  it("writes reset sequences only to a custom TTY stream", () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const resetWrite = vi.fn(() => true);
    const resetStream = { isTTY: true, write: resetWrite } as unknown as NodeJS.WriteStream;

    configureTerminalIO(false, true);
    restoreTerminalState("test", { resetStream });

    expect(resetWrite).toHaveBeenCalledWith(expect.stringContaining("\x1b[?25h"));
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
