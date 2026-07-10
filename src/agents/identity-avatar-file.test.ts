// Internal avatar-file tests cover pinned reads, limits, and workspace boundaries.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AVATAR_INLINE_DATA_URL_CHARS,
  AVATAR_INLINE_MAX_BYTES,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DATA_URL_CHARS,
} from "../shared/avatar-policy.js";
import {
  openLocalAgentAvatarFile,
  readOpenedLocalAgentAvatarDataUrl,
  resolveAgentAvatarUrlFromSource,
} from "./identity-avatar-file.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function createWorkspace(): { workspace: string; cfg: OpenClawConfig } {
  const root = tempRoots.make("openclaw-avatar-file-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  return {
    workspace,
    cfg: { agents: { list: [{ id: "main", workspace }] } },
  };
}

describe("local agent avatar files", () => {
  it("reads a pinned local file with the shared MIME policy", () => {
    const { cfg, workspace } = createWorkspace();
    const body = Buffer.from("avatar");
    fs.writeFileSync(path.join(workspace, "avatar.jpeg"), body);

    expect(resolveAgentAvatarUrlFromSource(cfg, "main", "avatar.jpeg")).toBe(
      `data:image/jpeg;base64,${body.toString("base64")}`,
    );
  });

  it("passes through only bounded image data URLs for agent-list projections", () => {
    const { cfg } = createWorkspace();
    const prefix = "data:image/svg+xml;base64,";
    // Data URL at the inline projection budget — should pass through
    const inlineExact = `${prefix}${"A".repeat(AVATAR_INLINE_DATA_URL_CHARS - prefix.length)}`;
    expect(resolveAgentAvatarUrlFromSource(cfg, "main", inlineExact)).toBe(inlineExact);

    // Data URL one char over the inline budget — reject
    expect(resolveAgentAvatarUrlFromSource(cfg, "main", `${inlineExact}A`)).toBeUndefined();

    // Data URL at the acceptance budget but over inline budget — reject
    const bigExact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;
    expect(resolveAgentAvatarUrlFromSource(cfg, "main", bigExact)).toBeUndefined();

    expect(resolveAgentAvatarUrlFromSource(cfg, "main", "data:text/plain,avatar")).toBeUndefined();
  });

  it("closes the pinned descriptor after inlining", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), "avatar");
    const opened = openLocalAgentAvatarFile({ cfg, agentId: "main", source: "avatar.png" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error("expected a pinned avatar descriptor");
    }

    expect(readOpenedLocalAgentAvatarDataUrl(opened.file)).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
    expect(() => fs.fstatSync(opened.file.fd)).toThrow();
  });

  it("rejects symlink escapes and hardlinks", () => {
    const { cfg, workspace } = createWorkspace();
    const outside = path.join(path.dirname(workspace), "outside.png");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(workspace, "symlink.png"));
    expect(openLocalAgentAvatarFile({ cfg, agentId: "main", source: "symlink.png" })).toEqual({
      ok: false,
      reason: "outside_workspace",
    });

    fs.writeFileSync(path.join(workspace, "original.png"), "avatar");
    fs.linkSync(path.join(workspace, "original.png"), path.join(workspace, "hardlink.png"));
    expect(openLocalAgentAvatarFile({ cfg, agentId: "main", source: "hardlink.png" })).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("rejects files above the shared byte limit before reading", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), Buffer.alloc(AVATAR_MAX_BYTES + 1));

    expect(openLocalAgentAvatarFile({ cfg, agentId: "main", source: "avatar.png" })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("does not project local avatars larger than the inline limit, even when accepted for storage", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "big.png"), Buffer.alloc(AVATAR_INLINE_MAX_BYTES + 1));

    expect(resolveAgentAvatarUrlFromSource(cfg, "main", "big.png")).toBeUndefined();
  });

  it("projects an avatar at the exact inline byte limit as a data URL", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "exact.png"), Buffer.alloc(AVATAR_INLINE_MAX_BYTES));

    const url = resolveAgentAvatarUrlFromSource(cfg, "main", "exact.png");
    expect(url).toMatch(/^data:image\/png;base64,/);
  });
});

describe("real gateway projection proof (PR #103409)", () => {
  it("simulates 3 large avatars reproducing the original 4.15 MB agents.list issue", async () => {
    const root = useAutoCleanupTempDirTracker(afterEach).make("avatar-proof-");
    const workspaces: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const dir = path.join(root, `w${i}`);
      fs.mkdirSync(dir, { recursive: true });
      workspaces.push(dir);
    }
    for (const ws of workspaces) {
      fs.writeFileSync(path.join(ws, "avatar.png"), Buffer.alloc(1400 * 1024));
    }

    const { listAgentsForGateway } = await import("../gateway/session-utils.js");
    const result = listAgentsForGateway({
      agents: {
        list: workspaces.map((ws, i) => ({
          id: `a${i + 1}`,
          workspace: ws,
          identity: { avatar: "avatar.png" },
        })),
      },
    } as any);

    const payload = JSON.stringify(result);
    console.log(
      "[proof 103409] 3× 1.4 MB avatars payload:",
      payload.length.toLocaleString(),
      "bytes",
    );
    for (const a of result.agents) {
      expect(a.identity?.avatarUrl).toBeUndefined();
      expect(a.identity?.avatar).toBe("avatar.png");
    }
    expect(payload.length).toBeLessThan(4096);
  });
});
