import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function createWorkspace(): { workspace: string; cfg: OpenClawConfig } {
  const root = tempRoots.make("openclaw-avatar-file-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  pool.run.mockImplementation(async (input: LocalAgentAvatarRead) =>
    structuredClone(readLocalAgentAvatarSnapshot(input)),
  );
  return {
    workspace,
    cfg: { agents: { list: [{ id: "main", workspace }] } },
  };
}

describe("local agent avatar files", () => {
  it("reads a pinned local file with the shared MIME policy", async () => {
    const { cfg, workspace } = createWorkspace();
    const body = Buffer.from("avatar");
    fs.writeFileSync(path.join(workspace, "avatar.jpeg"), body);
    expect(await resolveAgentAvatarUrlFromSource(cfg, "main", "avatar.jpeg")).toBe(
      `data:image/jpeg;base64,${body.toString("base64")}`,
    );
  });

  it("passes through only bounded image data URLs for agent-list projections", async () => {
    const { cfg } = createWorkspace();
    const prefix = "data:image/svg+xml;base64,";
    const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;
    expect(await resolveAgentAvatarUrlFromSource(cfg, "main", exact)).toBe(exact);
    expect(await resolveAgentAvatarUrlFromSource(cfg, "main", `${exact}A`)).toBeUndefined();
    expect(
      await resolveAgentAvatarUrlFromSource(cfg, "main", "data:text/plain,avatar"),
    ).toBeUndefined();
  });

  it("does not read bytes for metadata or retransmit an unchanged body", () => {
    const { workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), "avatar");
    const input = { workspaceDir: workspace, source: "avatar.png", readBody: false };
    const read = vi.spyOn(fs, "readSync");
    const metadata = readLocalAgentAvatarSnapshot(input);
    expect(metadata).toMatchObject({ ok: true, file: { stat: { size: 6 } } });
    expect(read).not.toHaveBeenCalled();
    if (!("ok" in metadata) || !metadata.ok) {
      throw new Error("expected avatar metadata");
    }
    expect(metadata.file.body).toBeUndefined();
    const body = readLocalAgentAvatarSnapshot({ ...input, readBody: true });
    expect(body).toMatchObject({
      ok: true,
      file: { body: Uint8Array.from(Buffer.from("avatar")) },
    });
    read.mockClear();
    expect(
      readLocalAgentAvatarSnapshot({
        ...input,
        readBody: true,
        knownRevision: localAgentAvatarRevision(metadata.file),
      }),
    ).toEqual({ kind: "unchanged" });
    expect(read).not.toHaveBeenCalled();
  });

  it("retains the admitted inode when the path is replaced during the read", () => {
    const { workspace } = createWorkspace();
    const avatarPath = path.join(workspace, "avatar.png");
    const replacement = path.join(workspace, "replacement.png");
    fs.writeFileSync(avatarPath, "original");
    fs.writeFileSync(replacement, "replacement");
    const readSync = fs.readSync;
    const read = vi.spyOn(fs, "readSync").mockImplementationOnce((...args) => {
      fs.renameSync(replacement, avatarPath);
      return Reflect.apply(readSync, fs, args);
    });
    const close = vi.spyOn(fs, "closeSync");
    const result = readLocalAgentAvatarSnapshot({
      workspaceDir: workspace,
      source: "avatar.png",
      readBody: true,
    });
    expect(result).toMatchObject({
      ok: true,
      file: { body: Uint8Array.from(Buffer.from("original")) },
    });
    expect(read).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds growth after admission and closes the pinned descriptor", () => {
    const { workspace } = createWorkspace();
    const avatarPath = path.join(workspace, "avatar.png");
    fs.writeFileSync(avatarPath, "avatar");
    const readSync = fs.readSync;
    let readFd: number | undefined;
    vi.spyOn(fs, "readSync").mockImplementationOnce((...args) => {
      readFd = args[0];
      fs.appendFileSync(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES));
      return Reflect.apply(readSync, fs, args);
    });
    const close = vi.spyOn(fs, "closeSync");
    expect(
      readLocalAgentAvatarSnapshot({
        workspaceDir: workspace,
        source: "avatar.png",
        readBody: true,
      }),
    ).toEqual({ ok: false, reason: "unreadable" });
    expect(readFd).toBeTypeOf("number");
    expect(close.mock.calls.filter(([fd]) => fd === readFd)).toHaveLength(1);
  });

  it("closes the descriptor after a failed read", () => {
    const { workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), "avatar");
    vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    const close = vi.spyOn(fs, "closeSync");
    expect(
      readLocalAgentAvatarSnapshot({
        workspaceDir: workspace,
        source: "avatar.png",
        readBody: true,
      }),
    ).toEqual({ ok: false, reason: "unreadable" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects symlink escapes, hardlinks, oversized files, and unsupported extensions", () => {
    const { workspace } = createWorkspace();
    const outside = path.join(path.dirname(workspace), "outside.png");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(workspace, "symlink.png"));
    fs.writeFileSync(path.join(workspace, "original.png"), "avatar");
    fs.linkSync(path.join(workspace, "original.png"), path.join(workspace, "hardlink.png"));
    fs.writeFileSync(path.join(workspace, "large.png"), Buffer.alloc(AVATAR_MAX_BYTES + 1));
    for (const [source, reason] of [
      ["symlink.png", "outside_workspace"],
      ["hardlink.png", "unreadable"],
      ["large.png", "too_large"],
      ["missing.png", "missing"],
      ["avatar.txt", "unsupported_extension"],
    ] as const) {
      expect(
        readLocalAgentAvatarSnapshot({ workspaceDir: workspace, source, readBody: true }),
      ).toEqual({ ok: false, reason });
    }
  });

  it("keeps the byte budget when a pending revalidation was evicted", async () => {
    const { cfg, workspace } = createWorkspace();
    const sources = Array.from({ length: 9 }, (_, index) => `${index}.png`);
    const body = Buffer.alloc(AVATAR_MAX_BYTES);
    for (const source of sources) {
      fs.writeFileSync(path.join(workspace, source), body);
    }
    const prepare = (source: string) =>
      prepareLocalAgentAvatarFile({ cfg, agentId: "main", source, readBody: true });
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
    expect(await prepare(sources[1]!)).not.toBe(oldest);
  });

  it("coalesces cold work, reuses warm bodies, and revalidates edits, replacements, and removal", async () => {
    const { cfg, workspace } = createWorkspace();
    const avatarPath = path.join(workspace, "avatar.png");
    fs.writeFileSync(avatarPath, "original");
    const unchangedMtime = new Date("2024-01-01T00:00:00Z");
    fs.utimesSync(avatarPath, unchangedMtime, unchangedMtime);
    const originalStat = fs.statSync(avatarPath);
    const originalFstatSync = fs.fstatSync;
    // Control the ctime tick without depending on the filesystem's timestamp resolution.
    let ctimeMs = originalStat.ctimeMs;
    vi.spyOn(fs, "fstatSync").mockImplementation((fd, options) => {
      const stat = originalFstatSync(fd, options);
      if (stat.dev === originalStat.dev && stat.ino === originalStat.ino) {
        stat.ctimeMs = ctimeMs;
      }
      return stat;
    });
    const params = { cfg, agentId: "main", source: "avatar.png", readBody: true };
    const [first, duplicate] = await Promise.all([
      prepareLocalAgentAvatarFile(params),
      prepareLocalAgentAvatarFile(params),
    ]);
    expect(duplicate).toBe(first);
    expect(pool.run).toHaveBeenCalledOnce();
    expect(await prepareLocalAgentAvatarFile(params)).toBe(first);
    expect(pool.run).toHaveBeenCalledTimes(2);
    fs.writeFileSync(avatarPath, "modified");
    fs.utimesSync(avatarPath, unchangedMtime, unchangedMtime);
    ctimeMs += 1;
    expect(await prepareLocalAgentAvatarFile(params)).toMatchObject({
      ok: true,
      file: {
        body: Buffer.from("modified"),
        stat: {
          ctimeMs,
          dev: originalStat.dev,
          ino: originalStat.ino,
          mtimeMs: originalStat.mtimeMs,
          size: originalStat.size,
        },
      },
    });
    const replacement = path.join(workspace, "replacement.png");
    fs.writeFileSync(replacement, "replacement bytes");
    fs.renameSync(replacement, avatarPath);
    expect(await prepareLocalAgentAvatarFile(params)).toMatchObject({
      ok: true,
      file: { body: Buffer.from("replacement bytes") },
    });
    fs.unlinkSync(avatarPath);
    expect(await prepareLocalAgentAvatarFile(params)).toEqual({ ok: false, reason: "missing" });
    fs.writeFileSync(avatarPath, "recreated");
    expect(await prepareLocalAgentAvatarFile(params)).toMatchObject({
      ok: true,
      file: { body: Buffer.from("recreated") },
    });
  });

  it("revalidates cached metadata before acquiring bytes and after symlink or workspace changes", async () => {
    const { cfg, workspace } = createWorkspace();
    const firstPath = path.join(workspace, "first.png");
    const secondPath = path.join(workspace, "second.png");
    const avatarPath = path.join(workspace, "avatar.png");
    fs.writeFileSync(firstPath, "first");
    fs.writeFileSync(secondPath, "second");
    fs.symlinkSync(firstPath, avatarPath);
    const params = { cfg, agentId: "main", source: "avatar.png", readBody: false };
    expect(await prepareLocalAgentAvatarFile(params)).toMatchObject({
      ok: true,
      file: { body: undefined },
    });
    expect(await prepareLocalAgentAvatarFile({ ...params, readBody: true })).toMatchObject({
      ok: true,
      file: { body: Buffer.from("first") },
    });
    fs.unlinkSync(avatarPath);
    fs.symlinkSync(secondPath, avatarPath);
    expect(await prepareLocalAgentAvatarFile({ ...params, readBody: true })).toMatchObject({
      ok: true,
      file: { body: Buffer.from("second") },
    });
    fs.linkSync(secondPath, path.join(workspace, "hardlink.png"));
    expect(await prepareLocalAgentAvatarFile(params)).toEqual({ ok: false, reason: "unreadable" });

    const changed = createWorkspace();
    fs.writeFileSync(path.join(changed.workspace, "avatar.png"), "changed workspace");
    expect(
      await prepareLocalAgentAvatarFile({ ...params, cfg: changed.cfg, readBody: true }),
    ).toMatchObject({ ok: true, file: { body: Buffer.from("changed workspace") } });
  });
});
