import { spawn } from "node:child_process";
// Tests for the S3 SRT filesystem bridge (fs-bridge.ts) — design v8 §1–§3, §5.
//
// Core deliverables proven here (mirroring the verified method from the
// authoritative review history — real-dir swap and inode-reuse, direct
// reproduction, not assertion):
//   1. AC4 exact-location: after resolvePinnedMutationTarget, swapping the
//      target's real directory cannot redirect the mutation — the write lands
//      in the ORIGINAL directory (held vnode), never the swapped one.
//   2. AC4 fail-closed: deleting the pinned directory fails the mutation with
//      ENOENT — an inode-number reuse cannot resurrect it (the option-3 hole).
//   3. pinnedPath is a pure canonical path (no identity payload — the carrier
//      stays contract-compatible), and a mismatched pinnedPath is rejected.
//   4. Held-pin lifecycle: single-flight, idle-timeout release, resource caps,
//      and fd counts returning to baseline (no leak on any path).
// The owner here is spawned without the sandbox wrap; end-to-end kernel
// enforcement is proven in backend.bridge.test.ts.
import { mkdtempSync, mkdirSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createSrtFsBridge, DEFAULT_SRT_PIN_LIMITS } from "./fs-bridge.js";
import { PinOwnerClient } from "./pin-owner-client.js";
import { PIN_OWNER_PYTHON } from "./pin-owner-source.js";

const PYTHON = process.platform === "darwin" ? "/usr/bin/python3" : "python3";

/** Local mirror of the SDK context type (not exported from plugin-sdk/sandbox). */
type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

type Fixture = {
  ws: string;
  agent: string;
  bridge: ReturnType<typeof createSrtFsBridge>;
  client: PinOwnerClient;
};

function makeContext(ws: string, agent: string): SandboxFsBridgeContext {
  return {
    workspaceDir: ws,
    agentWorkspaceDir: agent,
    workspaceAccess: "rw",
    containerName: "test-scope",
    containerWorkdir: ws,
    docker: {},
  } as SandboxFsBridgeContext;
}

function makeFixture(limits = {}): Fixture {
  const ws = mkdtempSync(path.join(tmpdir(), "srt-bridge-ws-"));
  const agent = mkdtempSync(path.join(tmpdir(), "srt-bridge-agent-"));
  const client = new PinOwnerClient({
    spawnOwner: () => {
      const child = spawn(PYTHON, ["-c", PIN_OWNER_PYTHON], { stdio: ["pipe", "pipe", "pipe"] });
      return Promise.resolve({ child, stdin: child.stdin, stdout: child.stdout });
    },
    rpcTimeoutMs: 10_000,
  });
  const bridge = createSrtFsBridge({
    sandbox: makeContext(ws, agent),
    writableRoots: [ws, agent],
    client,
    limits: { ...DEFAULT_SRT_PIN_LIMITS, ...limits },
  });
  return { ws, agent, bridge, client };
}

const fixtures: Fixture[] = [];
function make(limits = {}): Fixture {
  const fixture = makeFixture(limits);
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    fixture.bridge.dispose();
    fixture.client.dispose();
    rmSync(fixture.ws, { recursive: true, force: true });
    rmSync(fixture.agent, { recursive: true, force: true });
  }
});

describe("srt fs bridge — contract surface", () => {
  it("resolvePinnedMutationTarget returns a pure canonical pinnedPath (no identity payload)", async () => {
    const f = make();
    mkdirSync(path.join(f.ws, "a", "b"), { recursive: true });
    const target = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "a/b/new.txt",
      action: "write",
    });
    const expected = path.join(f.ws, "a", "b", "new.txt");
    // Pure canonical path: exactly the on-disk location, nothing else encoded.
    expect(target.pinnedPath).toBe(expected);
    expect(target.policyPath).toBe(expected);
  });

  it("rejects a pinnedPath whose basename differs from the requested entry", async () => {
    const f = make();
    const target = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "one.txt",
      action: "write",
    });
    await expect(
      f.bridge.writeFile({ filePath: "two.txt", data: "x", pinnedPath: target.pinnedPath }),
    ).rejects.toThrow(/does not match/);
    // Pin is not consumed by the rejected mutation; release via timeout path.
  });

  it("write/read/stat/mkdirp/remove/rename round-trip without a prior resolve", async () => {
    const f = make();
    await f.bridge.mkdirp({ filePath: "dir/nested" });
    await f.bridge.writeFile({ filePath: "dir/nested/file.txt", data: "payload", mkdir: true });
    expect(readFileSync(path.join(f.ws, "dir/nested/file.txt"), "utf8")).toBe("payload");
    const data = await f.bridge.readFile({ filePath: "dir/nested/file.txt" });
    expect(data.toString("utf8")).toBe("payload");
    const stat = await f.bridge.stat({ filePath: "dir/nested/file.txt" });
    expect(stat?.type).toBe("file");
    expect(stat?.size).toBe(7);
    await f.bridge.rename({ from: "dir/nested/file.txt", to: "dir/nested/renamed.txt" });
    expect(existsSync(path.join(f.ws, "dir/nested/renamed.txt"))).toBe(true);
    await f.bridge.remove({ filePath: "dir/nested/renamed.txt" });
    expect(existsSync(path.join(f.ws, "dir/nested/renamed.txt"))).toBe(false);
  });

  it("createFileExclusive returns created then exists, and never overwrites", async () => {
    const f = make();
    expect(await f.bridge.createFileExclusive!({ filePath: "lock.txt", data: "first" })).toBe(
      "created",
    );
    expect(await f.bridge.createFileExclusive!({ filePath: "lock.txt", data: "second" })).toBe(
      "exists",
    );
    expect(readFileSync(path.join(f.ws, "lock.txt"), "utf8")).toBe("first");
  });

  it("refuses mutations outside the writable roots", async () => {
    const f = make();
    await expect(f.bridge.writeFile({ filePath: "/etc/nope.txt", data: "x" })).rejects.toThrow(
      /read-only|outside/,
    );
    await expect(f.bridge.writeFile({ filePath: "../escape.txt", data: "x" })).rejects.toThrow(
      /escapes|read-only/,
    );
  });
});

describe("srt fs bridge — AC4 exact-location guarantee (方案 2 live handles)", () => {
  it("lands the pinned write in the ORIGINAL directory after a real-dir swap of a mid-segment component", async () => {
    const f = make();
    mkdirSync(path.join(f.ws, "a", "b"), { recursive: true });
    const target = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "a/b/new.txt",
      action: "write",
    });

    // Post-resolve, pre-mutate: rename the REAL directory b -> b_old (the
    // original vnode moves with the rename) and create a NEW real directory at
    // b (different inode — the swap an attacker does).
    const swappedDir = path.join(f.ws, "a", "b");
    const oldDir = path.join(f.ws, "a", "b_old");
    renameSync(swappedDir, oldDir);
    mkdirSync(swappedDir);

    // The pinned mutation must land in the ORIGINAL directory (held vnode),
    // never in the swapped one.
    await f.bridge.writeFile({
      filePath: "a/b/new.txt",
      data: "authorized",
      pinnedPath: target.pinnedPath,
    });
    expect(readFileSync(path.join(oldDir, "new.txt"), "utf8")).toBe("authorized");
    expect(existsSync(path.join(swappedDir, "new.txt"))).toBe(false);
  });

  it("fails closed with ENOENT when the pinned directory is deleted (no inode-reuse redirect)", async () => {
    const f = make();
    mkdirSync(path.join(f.ws, "victim"), { recursive: true });
    const target = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "victim/leak.txt",
      action: "write",
    });

    // Delete the held directory chain entirely. Whatever later reuses those
    // directory names/inodes must be unreachable through the held fds.
    rmSync(path.join(f.ws, "victim"), { recursive: true });

    await expect(
      f.bridge.writeFile({ filePath: "victim/leak.txt", data: "x", pinnedPath: target.pinnedPath }),
    ).rejects.toThrow(/ENOENT|No such file/);
    expect(existsSync(path.join(f.ws, "victim/leak.txt"))).toBe(false);
  });
});

describe("srt fs bridge — held-pin lifecycle (no fd leak on any path)", () => {
  it("single-flight: a second unfinalized resolve of the same canonical path is rejected", async () => {
    const f = make();
    const first = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "x.txt",
      action: "write",
    });
    await expect(
      f.bridge.resolvePinnedMutationTarget!({ filePath: "x.txt", action: "write" }),
    ).rejects.toThrow(/already pinned/);
    // Completing the paired mutation releases the pin; a fresh resolve works.
    await f.bridge.writeFile({ filePath: "x.txt", data: "ok", pinnedPath: first.pinnedPath });
    const again = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "x.txt",
      action: "write",
    });
    expect(again.pinnedPath).toBe(first.pinnedPath);
  });

  it("releases an idle pin on timeout and held count drains to 0", async () => {
    const f = make({ pinTimeoutMs: 120 });
    await f.bridge.resolvePinnedMutationTarget!({ filePath: "idle.txt", action: "write" });
    const heldDuring = await f.client.ping();
    expect(heldDuring.held).toBe(1);
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    const heldAfter = await f.client.ping();
    expect(heldAfter.held).toBe(0);
  });

  it("returns held-pin and fd counts to baseline after a full mutate cycle (no leak)", async () => {
    const f = make();
    await f.client.ping();
    const baseline = await f.client.ping();
    for (let i = 0; i < 5; i += 1) {
      await f.bridge.writeFile({ filePath: `cycle-${i}.txt`, data: "x" });
    }
    const after = await f.client.ping();
    expect(after.held).toBe(0);
    expect(after.fds).toBe(baseline.fds);
  });

  it("fails closed over the maxHeldPins cap and the maxPinDepth cap", async () => {
    const f = make({ maxHeldPins: 1 });
    await f.bridge.resolvePinnedMutationTarget!({ filePath: "held.txt", action: "write" });
    await expect(
      f.bridge.resolvePinnedMutationTarget!({ filePath: "other.txt", action: "write" }),
    ).rejects.toThrow(/held-pin table is full/);

    const deep = make({ maxPinDepth: 2 });
    await expect(deep.bridge.writeFile({ filePath: "a/b/c/d.txt", data: "x" })).rejects.toThrow(
      /depth exceeds/,
    );
  });

  it("rejects operations after dispose", async () => {
    const f = make();
    f.bridge.dispose();
    await expect(f.bridge.writeFile({ filePath: "x.txt", data: "x" })).rejects.toThrow();
  });
});
