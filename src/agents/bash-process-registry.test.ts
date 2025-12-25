import { beforeEach, describe, expect, it } from "vitest";
import {
  addSession,
  appendOutput,
  listFinishedSessions,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";

type DummyChild = {
  pid?: number;
};

describe("bash process registry", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  it("captures output and truncates", () => {
    const session = {
      id: "sess",
      command: "echo test",
      child: { pid: 123 } as DummyChild,
      startedAt: Date.now(),
      cwd: "/tmp",
      maxOutputChars: 10,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      aggregated: "",
      tail: "",
      exited: false,
      exitCode: undefined,
      exitSignal: undefined,
      truncated: false,
      backgrounded: false,
    };

    addSession(session as any);
    appendOutput(session as any, "stdout", "0123456789");
    appendOutput(session as any, "stdout", "abcdef");

    expect(session.aggregated).toBe("6789abcdef");
    expect(session.truncated).toBe(true);
  });

  it("only persists finished sessions when backgrounded", () => {
    const session = {
      id: "sess",
      command: "echo test",
      child: { pid: 123 } as DummyChild,
      startedAt: Date.now(),
      cwd: "/tmp",
      maxOutputChars: 100,
      totalOutputChars: 0,
      pendingStdout: [],
      pendingStderr: [],
      aggregated: "",
      tail: "",
      exited: false,
      exitCode: undefined,
      exitSignal: undefined,
      truncated: false,
      backgrounded: false,
    };

    addSession(session as any);
    markExited(session as any, 0, null, "completed");
    expect(listFinishedSessions()).toHaveLength(0);

    markBackgrounded(session as any);
    markExited(session as any, 0, null, "completed");
    expect(listFinishedSessions()).toHaveLength(1);
  });
});
