import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  localAgentAvatarRevision,
  prepareLocalAgentAvatarFile,
  readLocalAgentAvatarSnapshot,
  resolveAgentAvatarUrlFromSource,
  type LocalAgentAvatarRead,
} from "./identity-avatar-file.js";

const pool = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock("../infra/worker-task-pool.js", () => ({
  WorkerTaskPool: class {
    run = pool.run;
    close = pool.close;
  },
  WorkerTaskError: class extends Error {},
}));
vi.mock("../infra/runtime-process-url.js", () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///local-avatar.worker.js"),
}));

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.restoreAllMocks();
  pool.run.mockReset();
});

function createWorkspace(avatar?: string) {
  const workspace = tempRoots.make("openclaw-avatar-file-");
  const file = (name: string) => path.join(workspace, name);
  const write = (name: string, body: string | Uint8Array) => {
    fs.writeFileSync(file(name), body);
    return file(name);
  };
  if (avatar !== undefined) {
    write("avatar.png", avatar);
  }
  pool.run.mockImplementation(async (input: LocalAgentAvatarRead) =>
    structuredClone(readLocalAgentAvatarSnapshot(input)),
  );
  const cfg: OpenClawConfig = { agents: { entries: { main: { workspace } } } };
  return {
    file,
    write,
    symlink: (target: string, name = "avatar.png") => fs.symlinkSync(file(target), file(name)),
    hardlink: (target: string, name = "hardlink.png") => fs.linkSync(file(target), file(name)),
    read: (source = "avatar.png", readBody = true, knownRevision?: string) =>
      readLocalAgentAvatarSnapshot({ workspaceDir: workspace, source, readBody, knownRevision }),
    prepare: (source = "avatar.png", readBody = true) =>
      prepareLocalAgentAvatarFile({ cfg, agentId: "main", source, readBody }),
    url: (source: string) => resolveAgentAvatarUrlFromSource(cfg, "main", source),
  };
}

function expectBody(result: unknown, body: string | Uint8Array | undefined) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  expect(result).toMatchObject({ ok: true, file: { body: bytes } });
}

it("reads a pinned local file with the shared MIME policy", async () => {
  const { url, write } = createWorkspace();
  const body = Buffer.from("avatar");
  write("avatar.jpeg", body);
  expect(await url("avatar.jpeg")).toBe(`data:image/jpeg;base64,${body.toString("base64")}`);
});

it("encodes unchanged avatars once across list clients and refreshes changed files", async () => {
  const { prepare, url, write, file } = createWorkspace("original");
  const first = await prepare();
  assert(first.ok && first.file.body);
  const encode = vi.spyOn(first.file.body, "toString");
  for (let poll = 0; poll < 3; poll += 1) {
    expect(await Promise.all(Array.from({ length: 4 }, () => url("avatar.png")))).toEqual(
      Array(4).fill("data:image/png;base64,b3JpZ2luYWw="),
    );
  }
  expect(encode).toHaveBeenCalledTimes(1);
  expect(pool.run).toHaveBeenCalledTimes(1);

  fs.renameSync(write("replacement.png", "changed"), file("avatar.png"));
  expect(await url("avatar.png")).toBe("data:image/png;base64,Y2hhbmdlZA==");
  fs.unlinkSync(file("avatar.png"));
  expect(await url("avatar.png")).toBeUndefined();
});

it("passes through only bounded image data URLs for agent-list projections", async () => {
  const { url } = createWorkspace();
  const prefix = "data:image/svg+xml;base64,";
  const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;
  expect(await url(exact)).toBe(exact);
  expect(await url(`${exact}A`)).toBeUndefined();
  expect(await url("data:text/plain,avatar")).toBeUndefined();
});

it("reuses a cached avatar without synchronous filesystem calls on the request thread", async () => {
  const { prepare } = createWorkspace("original");
  const first = await prepare();
  const stat = vi.spyOn(fs, "statSync");
  const nativeRealpath = vi.spyOn(fs.realpathSync, "native");
  const realpath = vi.spyOn(fs, "realpathSync");
  const open = vi.spyOn(fs, "openSync");
  expect(await prepare()).toBe(first);
  expect(pool.run).toHaveBeenCalledOnce();
  expect(stat).not.toHaveBeenCalled();
  expect(realpath).not.toHaveBeenCalled();
  expect(nativeRealpath).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it("does not submit new worker work when shutdown overlaps asynchronous freshness checks", async () => {
  const { prepare } = createWorkspace("original");
  await prepare();
  const started = createDeferred();
  const release = createDeferred();
  vi.spyOn(fs.promises, "stat").mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("file no longer available");
  });
  const pending = prepare();
  await started.promise;
  const shutdown = drainGlobalSingletonLifecycleState();
  release.resolve();
  expect(await pending).toEqual({ ok: false, reason: "unreadable" });
  await shutdown;
  expect(pool.run).toHaveBeenCalledOnce();
});

it("does not read bytes for metadata or retransmit an unchanged body", () => {
  const { read: snapshot } = createWorkspace("avatar");
  const read = vi.spyOn(fs, "readSync");
  const metadata = snapshot("avatar.png", false);
  expect(metadata).toMatchObject({ ok: true, file: { stat: { size: 6 }, body: undefined } });
  expect(read).not.toHaveBeenCalled();
  assert("ok" in metadata && metadata.ok);
  expectBody(snapshot(), Uint8Array.from(Buffer.from("avatar")));
  read.mockClear();
  expect(snapshot("avatar.png", true, localAgentAvatarRevision(metadata.file))).toEqual({
    kind: "unchanged",
  });
  expect(read).not.toHaveBeenCalled();
});

it.each(["replacement", "growth", "failure"] as const)(
  "keeps reads pinned and closes the descriptor after %s",
  (change) => {
    const { file, write, read: snapshot } = createWorkspace("original");
    const replacement = write("replacement.png", "replacement");
    const readSync = fs.readSync;
    let readFd: number | undefined;
    vi.spyOn(fs, "readSync").mockImplementationOnce((...args) => {
      readFd = args[0];
      if (change === "failure") {
        throw new Error("read failed");
      }
      if (change === "replacement") {
        fs.renameSync(replacement, file("avatar.png"));
      } else {
        fs.appendFileSync(file("avatar.png"), Buffer.alloc(AVATAR_MAX_BYTES));
      }
      return Reflect.apply(readSync, fs, args);
    });
    const close = vi.spyOn(fs, "closeSync");
    const result = snapshot();
    if (change === "replacement") {
      expectBody(result, Uint8Array.from(Buffer.from("original")));
    } else {
      expect(result).toEqual({ ok: false, reason: "unreadable" });
    }
    expect(readFd).toBeTypeOf("number");
    expect(close.mock.calls.filter(([fd]) => fd === readFd)).toHaveLength(1);
    if (change !== "growth") {
      expect(close).toHaveBeenCalledOnce();
    }
  },
);

it("rejects symlink escapes, hardlinks, oversized files, and unsupported extensions", () => {
  const { write, symlink, hardlink, read } = createWorkspace("avatar");
  write("../outside.png", "outside");
  write("large.png", Buffer.alloc(AVATAR_MAX_BYTES + 1));
  symlink("../outside.png", "symlink.png");
  hardlink("avatar.png");
  for (const [source, reason] of [
    ["symlink.png", "outside_workspace"],
    ["hardlink.png", "unreadable"],
    ["large.png", "too_large"],
    ["missing.png", "missing"],
    ["avatar.txt", "unsupported_extension"],
  ] as const) {
    expect(read(source)).toEqual({ ok: false, reason });
  }
});

it.each(["changed", "unchanged"])(
  "keeps the byte budget when a pending %s revalidation was evicted",
  async (change) => {
    const sources = Array.from({ length: 9 }, (_, index) => `${index}.png`);
    const body = Buffer.alloc(AVATAR_MAX_BYTES);
    const { write, prepare, file } = createWorkspace();
    sources.forEach((source) => write(source, body));
    await prepare(sources[0]!);
    const started = createDeferred();
    const release = createDeferred();
    if (change === "changed") {
      write(sources[0]!, Buffer.alloc(AVATAR_MAX_BYTES, 1));
      pool.run.mockImplementationOnce(async (input: LocalAgentAvatarRead) => {
        const result = structuredClone(readLocalAgentAvatarSnapshot(input));
        started.resolve();
        await release.promise;
        return result;
      });
    } else {
      const stat = await fs.promises.stat(file(sources[0]!), { bigint: true });
      vi.spyOn(fs.promises, "stat").mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return stat;
      });
    }
    const pending = prepare(sources[0]!);
    await started.promise;
    let oldest;
    try {
      oldest = await prepare(sources[1]!);
      for (const source of sources.slice(2)) {
        await prepare(source);
      }
    } finally {
      release.resolve();
      await pending;
    }
    // Reinstalling the pending image must evict the oldest of the eight retained 2 MiB images.
    expect(Object.is(await prepare(sources[1]!), oldest)).toBe(false);
  },
);

it("coalesces cold work, reuses warm bodies, and revalidates edits, replacements, and removal", async () => {
  const { file, write, prepare } = createWorkspace("original");
  const avatarPath = file("avatar.png");
  const unchangedMtime = new Date("2024-01-01T00:00:00Z");
  fs.utimesSync(avatarPath, unchangedMtime, unchangedMtime);
  const originalIdentity = fs.statSync(avatarPath, { bigint: true });
  const originalFstatSync = fs.fstatSync;
  const originalStat = fs.promises.stat;
  // fs-safe derives numeric metadata from the pinned descriptor's bigint observation.
  let ctimeMs = unchangedMtime.getTime();
  vi.spyOn(fs.promises, "stat").mockImplementation(async (lookupPath, options) => {
    if (options?.bigint) {
      const stat = await originalStat(lookupPath, { bigint: true });
      if (stat.dev === originalIdentity.dev && stat.ino === originalIdentity.ino) {
        stat.ctimeNs = BigInt(ctimeMs) * 1_000_000n;
        stat.ctimeMs = BigInt(ctimeMs);
      }
      return stat;
    }
    return originalStat(lookupPath, options);
  });
  vi.spyOn(fs, "fstatSync").mockImplementation((fd, options) => {
    if (options?.bigint) {
      const stat = originalFstatSync(fd, { bigint: true });
      if (stat.dev === originalIdentity.dev && stat.ino === originalIdentity.ino) {
        stat.ctimeNs = BigInt(ctimeMs) * 1_000_000n;
        stat.ctimeMs = BigInt(ctimeMs);
      }
      return stat;
    }
    return originalFstatSync(fd, options);
  });
  const [first, duplicate] = await Promise.all([prepare(), prepare()]);
  expect(duplicate).toBe(first);
  expect(pool.run).toHaveBeenCalledOnce();
  expect(await prepare()).toBe(first);
  expect(pool.run).toHaveBeenCalledTimes(1);
  fs.writeFileSync(avatarPath, "modified");
  fs.utimesSync(avatarPath, unchangedMtime, unchangedMtime);
  ctimeMs += 1;
  expectBody(await prepare(), "modified");
  const replacement = write("replacement.png", "replacement bytes");
  fs.renameSync(replacement, avatarPath);
  expectBody(await prepare(), "replacement bytes");
  fs.unlinkSync(avatarPath);
  expect(await prepare()).toEqual({ ok: false, reason: "missing" });
  fs.writeFileSync(avatarPath, "recreated");
  expectBody(await prepare(), "recreated");
});

it("revalidates cached metadata before acquiring bytes and after symlink or workspace changes", async () => {
  const { file, write, symlink, hardlink, prepare } = createWorkspace();
  write("first.png", "first");
  write("second.png", "second");
  symlink("first.png");
  expectBody(await prepare("avatar.png", false), undefined);
  expectBody(await prepare(), "first");
  fs.unlinkSync(file("avatar.png"));
  symlink("second.png");
  expectBody(await prepare(), "second");
  expectBody(await prepare(), "second");
  hardlink("second.png");
  expect(await prepare()).toEqual({ ok: false, reason: "unreadable" });
  expect(await prepare("avatar.png", false)).toEqual({ ok: false, reason: "unreadable" });

  const changed = createWorkspace("changed workspace");
  expectBody(await changed.prepare(), "changed workspace");
});

it("rejects a cached avatar moved outside its workspace and replaced by a symlink", async () => {
  const { file, prepare } = createWorkspace("private avatar");
  expectBody(await prepare(), "private avatar");
  const outside = tempRoots.make("openclaw-avatar-outside-");
  const moved = path.join(outside, "avatar.png");
  fs.renameSync(file("avatar.png"), moved);
  fs.symlinkSync(moved, file("avatar.png"));
  expect(await prepare()).toEqual({ ok: false, reason: "outside_workspace" });
});

it("rechecks the workspace boundary even when the cached avatar identity is unchanged", async () => {
  const first = createWorkspace("first");
  const second = createWorkspace("second");
  const aliases = tempRoots.make("openclaw-avatar-workspace-alias-");
  const workspace = path.join(aliases, "workspace");
  fs.symlinkSync(first.file("."), workspace, "dir");
  const prepare = () =>
    prepareLocalAgentAvatarFile({
      cfg: { agents: { entries: { main: { workspace } } } },
      agentId: "main",
      source: first.file("avatar.png"),
      readBody: true,
    });
  expectBody(await prepare(), "first");
  expectBody(await prepare(), "first");
  fs.unlinkSync(workspace);
  fs.symlinkSync(second.file("."), workspace, "dir");
  expect(await prepare()).toEqual({ ok: false, reason: "outside_workspace" });
});

it("preserves admitted bytes when async and ordinary realpath resolve an alias differently", async () => {
  const { file, prepare } = createWorkspace("original");
  fs.symlinkSync("avatar.png", file("alias.png"));
  expectBody(await prepare("alias.png"), "original");
  const outside = tempRoots.make("openclaw-avatar-parent-target-");
  fs.mkdirSync(path.join(outside, "child"));
  fs.writeFileSync(path.join(outside, "avatar.png"), "outside");
  fs.symlinkSync(path.join(outside, "child"), file("link"), "dir");
  fs.unlinkSync(file("alias.png"));
  fs.symlinkSync(["link", "..", "avatar.png"].join(path.sep), file("alias.png"));
  // Ordinary admission normalizes the symlink's parent segment before following it.
  // An async freshness miss must defer to that owner, never read the outside file.
  expectBody(await prepare("alias.png"), "original");
});

it("rejects a changed workspace alias even when native realpath still reaches the cached file", async () => {
  const root = tempRoots.make("openclaw-avatar-workspace-parent-");
  fs.mkdirSync(path.join(root, "old", "workspace"), { recursive: true });
  fs.mkdirSync(path.join(root, "old", "child"));
  fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(path.join(root, "old", "workspace", "avatar.png"), "original");
  const workspace = path.join(root, "alias");
  fs.symlinkSync(path.join(root, "old", "workspace"), workspace, "dir");
  const cfg: OpenClawConfig = { agents: { entries: { main: { workspace } } } };
  const source = path.join(root, "old", "workspace", "avatar.png");
  pool.run.mockImplementation(async (input: LocalAgentAvatarRead) =>
    structuredClone(readLocalAgentAvatarSnapshot(input)),
  );
  const prepare = () =>
    prepareLocalAgentAvatarFile({ cfg, agentId: "main", source, readBody: true });
  expectBody(await prepare(), "original");
  fs.symlinkSync(path.join(root, "old", "child"), path.join(root, "link"), "dir");
  fs.unlinkSync(workspace);
  fs.symlinkSync(["link", "..", "workspace"].join(path.sep), workspace, "dir");
  expect(await prepare()).toEqual({ ok: false, reason: "outside_workspace" });
});

it.each(["alias.png/child", "avatar.png/."])(
  "rejects a cached avatar after its alias changes to an invalid physical target: %s",
  async (target) => {
    const { file, prepare } = createWorkspace("original");
    fs.symlinkSync("avatar.png", file("alias.png"));
    expectBody(await prepare("alias.png"), "original");
    fs.unlinkSync(file("alias.png"));
    fs.symlinkSync(target, file("alias.png"));
    expect(await prepare("alias.png")).toMatchObject({ ok: false });
  },
);
