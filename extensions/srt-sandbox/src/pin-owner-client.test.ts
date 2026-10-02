// Tests for the S3 pin-owner RPC client (pin-owner-client.ts).
//
// Covers the transport half of design v8 §3: spawn/respawn, response
// correlation, fail-closed on owner death, and dispose semantics. The AC4
// held-handle behavior itself is covered in fs-bridge.test.ts and the
// end-to-end enforcement in backend.bridge.test.ts.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { PinOwnerClient, PinOwnerDeadError, PinOwnerError } from "./pin-owner-client.js";
import { PIN_OWNER_PYTHON } from "./pin-owner-source.js";
import type { PersistentChildHandle } from "./scope-reaper.js";

const PYTHON = process.platform === "darwin" ? "/usr/bin/python3" : "python3";

async function spawnRealOwner(): Promise<PersistentChildHandle> {
  const child = spawn(PYTHON, ["-c", PIN_OWNER_PYTHON], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, stdin: child.stdin, stdout: child.stdout };
}

type FakeOwner = { handle: PersistentChildHandle; emitExit: () => void };

function spawnFakeOwner(): FakeOwner {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Partial<NodeJS.WritableStream>;
    stdout: Partial<NodeJS.ReadableStream>;
    killed: boolean;
  };
  const stdout = new EventEmitter();
  const stdin = {
    writes: [] as string[],
    write(text: string) {
      stdin.writes.push(text);
      return true;
    },
    end() {},
    on() {},
  };
  child.stdout = stdout as unknown as Partial<NodeJS.ReadableStream>;
  child.stdin = stdin as unknown as NodeJS.WritableStream;
  const owner = { handle: undefined as unknown as PersistentChildHandle, emitExit: () => {} };
  owner.handle = {
    child: child as unknown as PersistentChildHandle["child"],
    stdin: stdin as unknown as NodeJS.WritableStream,
    stdout: stdout as unknown as NodeJS.ReadableStream,
  };
  owner.emitExit = () => child.emit("exit", null, "SIGKILL");
  return owner;
}

describe("PinOwnerClient transport", () => {
  let client: PinOwnerClient | undefined;

  afterEach(() => {
    client?.dispose();
    client = undefined;
  });

  it("correlates a ping response and reports owner counters", async () => {
    client = new PinOwnerClient({ spawnOwner: spawnRealOwner, rpcTimeoutMs: 5000 });
    const pong = await client.ping();
    expect(pong.pid).toBeGreaterThan(0);
    expect(pong.held).toBe(0);
  });

  it("stat/read round-trip a file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "pinowner-read-"));
    const file = path.join(dir, "f.txt");
    writeFileSync(file, "hello pinned read");
    client = new PinOwnerClient({ spawnOwner: spawnRealOwner, rpcTimeoutMs: 5000 });
    const stat = await client.stat(file);
    expect(stat?.type).toBe("file");
    expect(stat?.size).toBe("hello pinned read".length);
    const data = await client.read(file);
    expect(data.toString("utf8")).toBe("hello pinned read");
    expect(await client.stat(path.join(dir, "missing.txt"))).toBeNull();
  });

  it("surfaces an owner-reported error as PinOwnerError with its errno", async () => {
    client = new PinOwnerClient({ spawnOwner: spawnRealOwner, rpcTimeoutMs: 5000 });
    await expect(client.read("/definitely/not/here.txt")).rejects.toBeInstanceOf(PinOwnerError);
  });

  it("fails in-flight calls closed when the owner dies, then respawns a fresh owner", async () => {
    let spawns = 0;
    const fake = spawnFakeOwner();
    client = new PinOwnerClient({
      spawnOwner: () => {
        spawns += 1;
        // First spawn is the fake owner that dies mid-flight; the respawn
        // gets a healthy real owner.
        return Promise.resolve(spawns === 1 ? fake.handle : spawnRealOwner());
      },
      rpcTimeoutMs: 5000,
    });
    const inFlight = client.ping();
    // Let the client finish attaching to the (fake) owner first, then the
    // fake owner dies without ever responding.
    while (!client.isOwnerRunning) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    fake.emitExit();
    await expect(inFlight).rejects.toBeInstanceOf(PinOwnerDeadError);
    // Next request respawns and succeeds.
    const pong = await client.ping();
    expect(pong.pid).toBeGreaterThan(0);
    expect(client.isOwnerRunning).toBe(true);
  });

  it("times out a wedged owner call fail-closed", async () => {
    const fake = spawnFakeOwner();
    client = new PinOwnerClient({
      spawnOwner: () => Promise.resolve(fake.handle),
      rpcTimeoutMs: 80,
    });
    await expect(client.ping()).rejects.toThrow(/timed out/);
  });

  it("rejects requests after dispose", async () => {
    client = new PinOwnerClient({ spawnOwner: spawnRealOwner, rpcTimeoutMs: 5000 });
    await client.ping();
    client.dispose();
    await expect(client.ping()).rejects.toBeInstanceOf(PinOwnerDeadError);
  });
});
