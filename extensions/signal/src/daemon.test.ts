// Signal tests cover daemon plugin behavior.
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSignalDaemon } from "./daemon.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 1234;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

let child: ReturnType<typeof createMockChild>;

beforeEach(() => {
  child = createMockChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
});

afterEach(() => {
  child.stdout.end();
  child.stderr.end();
  child.removeAllListeners();
});

describe("spawnSignalDaemon", () => {
  it("expands home-relative configPath before passing it to signal-cli", () => {
    spawnSignalDaemon({
      cliPath: "signal-cli",
      configPath: "~/.openclaw/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "signal-cli",
      [
        "--config",
        path.join(os.homedir(), ".openclaw/signal-cli"),
        "daemon",
        "--http",
        "127.0.0.1:8080",
        "--no-receive-stdout",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("classifies complete UTF-8 output lines through the spawned process", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    spawnSignalDaemon({
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime: {
        log: (...args) => logs.push(args.map(String).join(" ")),
        error: (...args) => errors.push(args.map(String).join(" ")),
        exit: vi.fn(),
      },
    });

    const ended = once(child.stderr, "end");
    child.stderr.write(Buffer.from("ER"));
    child.stderr.write(
      Buffer.from(
        "ROR DaemonCommand - startup failed\r\nWARN Manager - retrying\nreceive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed\npartial",
      ),
    );
    child.stderr.write(" warning\n");
    const utf8Line = Buffer.from("INFO Manager - café ready");
    const splitCodePointAt = utf8Line.indexOf(0xc3) + 1;
    child.stderr.write(utf8Line.subarray(0, splitCodePointAt));
    child.stderr.end(utf8Line.subarray(splitCodePointAt));
    await ended;

    expect(errors).toEqual(["signal-cli: ERROR DaemonCommand - startup failed"]);
    expect(logs).toEqual([
      "signal-cli: WARN Manager - retrying",
      "signal-cli: receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      "signal-cli: partial warning",
      "signal-cli: INFO Manager - café ready",
    ]);
  });

  it.each(["SEVERE Manager - database exception", "Failed to initialize HTTP Server - oops"])(
    "surfaces untagged failure output: %s",
    async (line) => {
      const error = vi.fn();
      spawnSignalDaemon({
        cliPath: "signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
        runtime: { log: vi.fn(), error, exit: vi.fn() },
      });

      const ended = once(child.stderr, "end");
      child.stderr.end(`${line}\n`);
      await ended;

      expect(error).toHaveBeenCalledWith(`signal-cli: ${line}`);
    },
  );
});
