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
  const root = tempRoots.make("openclaw-avatar-file-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
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

it("passes through only bounded image data URLs for agent-list projections", async () => {
  const { url } = createWorkspace();
  const prefix = "data:image/svg+xml;base64,";
  const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;
  expect(await url(exact)).toBe(exact);
  expect(await url(`${exact}A`)).toBeUndefined();
  expect(await url("data:text/plain,avatar")).toBeUndefined();
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

it("keeps the byte budget when a pending revalidation was evicted", async () => {
  const sources = Array.from({ length: 9 }, (_, index) => `${index}.png`);
  const body = Buffer.alloc(AVATAR_MAX_BYTES);
  const { write, prepare } = createWorkspace();
  sources.forEach((source) => write(source, body));
  await prepare(sources[0]!);
  const started = createDeferred();
  const release = createDeferred();
  pool.run.mockImplementationOnce(async (input: LocalAgentAvatarRead) => {
    const result = structuredClone(readLocalAgentAvatarSnapshot(input));
    started.resolve();
    await release.promise;
    return result;
  });
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
});

it("coalesces cold work, reuses warm bodies, and revalidates edits, replacements, and removal", async () => {
  const { file, write, prepare } = createWorkspace("original");
  const avatarPath = file("avatar.png");
  const unchangedMtime = new Date("2024-01-01T00:00:00Z");
  fs.utimesSync(avatarPath, unchangedMtime, unchangedMtime);
  const originalStat = fs.statSync(avatarPath);
  const originalIdentity = fs.statSync(avatarPath, { bigint: true });
  const originalFstatSync = fs.fstatSync;
  // fs-safe derives numeric metadata from the pinned descriptor's bigint observation.
  let ctimeMs = unchangedMtime.getTime();
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
  expect(pool.run).toHaveBeenCalledTimes(2);
  fs.writeFileSync(avatarPath, "modified");
  fs.utimesSync(avatarPath, unchangedMtime, unchangedMtime);
  ctimeMs += 1;
  expect(await prepare()).toMatchObject({
    ok: true,
    file: {
      body: Buffer.from("modified"),
      stat: {
        ctimeMs,
        dev: String(originalStat.dev),
        ino: String(originalStat.ino),
        mtimeMs: originalStat.mtimeMs,
        size: originalStat.size,
      },
    },
  });
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
  hardlink("second.png");
  expect(await prepare("avatar.png", false)).toEqual({ ok: false, reason: "unreadable" });

  const changed = createWorkspace("changed workspace");
  expectBody(await changed.prepare(), "changed workspace");
});
