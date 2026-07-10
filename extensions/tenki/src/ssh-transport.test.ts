import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSshExecArgv,
  ensureTenkiSshKeypair,
  startTenkiSshForwarder,
  waitForSshAuth,
} from "./ssh-transport.js";

describe("buildSshExecArgv", () => {
  it("builds a loopback ssh argv with pinned identity", () => {
    const argv = buildSshExecArgv({
      privateKeyPath: "/state/tenki/id_ed25519",
      port: 45678,
      usePty: false,
      remoteCommand: "/bin/sh -c 'pwd'",
    });
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-T");
    expect(argv).not.toContain("-tt");
    expect(argv).toContain("tenki@127.0.0.1");
    expect(argv[argv.indexOf("-p") + 1]).toBe("45678");
    expect(argv[argv.indexOf("-i") + 1]).toBe("/state/tenki/id_ed25519");
    expect(argv.at(-1)).toBe("/bin/sh -c 'pwd'");
  });

  it("allocates a PTY when requested", () => {
    const argv = buildSshExecArgv({
      privateKeyPath: "/k",
      port: 1,
      usePty: true,
      remoteCommand: "top",
    });
    expect(argv).toContain("-tt");
    expect(argv).not.toContain("-T");
  });
});

describe("ensureTenkiSshKeypair", () => {
  it("generates once and reuses the keypair", async () => {
    const dir = path.join(
      os.tmpdir(),
      `tenki-ssh-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    const first = await ensureTenkiSshKeypair(dir);
    expect(first.publicKey).toMatch(/^ssh-ed25519 /);
    expect(first.privateKeyPath).toBe(path.join(dir, "id_ed25519"));
    const second = await ensureTenkiSshKeypair(dir);
    expect(second.publicKey).toBe(first.publicKey);
  });
});

describe("waitForSshAuth", () => {
  it("throws after the deadline when ssh never authenticates", async () => {
    // Port 1 refuses instantly, so every ssh attempt exits non-zero.
    await expect(
      waitForSshAuth({
        privateKeyPath: "/nonexistent/key",
        port: 1,
        timeoutMs: 300,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/not ready/);
  });
});

describe("startTenkiSshForwarder", () => {
  it("binds a loopback port and closes cleanly", async () => {
    const forwarder = await startTenkiSshForwarder(async () => {
      throw new Error("no session in this test");
    });
    expect(forwarder.port).toBeGreaterThan(0);
    // A connection whose session resolution fails is destroyed, not hung.
    await new Promise<void>((resolve) => {
      const socket = net.connect(forwarder.port, "127.0.0.1");
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    forwarder.close();
  });
});
