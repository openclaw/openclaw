import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSshExecArgv,
  ensureTenkiSshKeypair,
  shouldRenewSessionSshCert,
  startTenkiSshForwarder,
  waitForSshAuth,
} from "./ssh-transport.js";

describe("buildSshExecArgv", () => {
  it("builds a loopback ssh argv with pinned identity and session cert", () => {
    const argv = buildSshExecArgv({
      privateKeyPath: "/state/tenki/id_ed25519",
      certificatePath: "/state/tenki/id_ed25519-sid-cert.pub",
      port: 45678,
      usePty: false,
      remoteCommand: "/bin/sh -c 'pwd'",
    });
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-T");
    expect(argv).not.toContain("-tt");
    expect(argv).toContain("tenki@127.0.0.1");
    expect(argv).toContain("CertificateFile=/state/tenki/id_ed25519-sid-cert.pub");
    expect(argv[argv.indexOf("-p") + 1]).toBe("45678");
    expect(argv[argv.indexOf("-i") + 1]).toBe("/state/tenki/id_ed25519");
    expect(argv.at(-1)).toBe("/bin/sh -c 'pwd'");
  });

  it("allocates a PTY when requested", () => {
    const argv = buildSshExecArgv({
      privateKeyPath: "/k",
      certificatePath: "/k-cert.pub",
      port: 1,
      usePty: true,
      remoteCommand: "top",
    });
    expect(argv).toContain("-tt");
    expect(argv).not.toContain("-T");
  });
});

describe("shouldRenewSessionSshCert", () => {
  const base = { certificatePath: "/c", mintedAtMs: 1_000 };

  it("keeps a fresh cert", () => {
    expect(
      shouldRenewSessionSshCert(
        { ...base, expiresAt: new Date(500_000), renewalAfterMs: 300_000 },
        2_000,
      ),
    ).toBe(false);
  });

  it("renews near expiry", () => {
    expect(shouldRenewSessionSshCert({ ...base, expiresAt: new Date(50_000) }, 2_000)).toBe(true);
  });

  it("renews after the issuance renewal hint", () => {
    expect(shouldRenewSessionSshCert({ ...base, renewalAfterMs: 10_000 }, 12_000)).toBe(true);
  });

  it("keeps a cert with no expiry metadata", () => {
    expect(shouldRenewSessionSshCert(base, 999_999_999)).toBe(false);
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
        certificatePath: "/nonexistent/key-cert.pub",
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
