import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { resolveAgentAvatar, resolvePublicAgentAvatarSource } from "./identity-avatar.js";

async function writeFile(filePath: string, contents = "avatar") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf-8");
}

async function expectLocalAvatarPath(
  cfg: OpenClawConfig,
  workspace: string,
  expectedRelativePath: string,
) {
  const workspaceReal = await fs.realpath(workspace);
  const resolved = resolveAgentAvatar(cfg, "main");
  expect(resolved.kind).toBe("local");
  if (resolved.kind === "local") {
    const resolvedReal = await fs.realpath(resolved.filePath);
    expect(path.relative(workspaceReal, resolvedReal)).toBe(expectedRelativePath);
  }
}

let root: string;
let workspace: string;
function avatarConfig(avatar?: string): OpenClawConfig {
  return { agents: { entries: { main: { workspace, identity: { avatar } } } } };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-"));
  workspace = path.join(root, "work");
  await fs.mkdir(workspace);
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("resolveAgentAvatar", () => {
  it("falls back to IDENTITY.md when config has no avatar", async () => {
    const avatarPath = path.join(workspace, "avatars", "fallback.png");
    await writeFile(avatarPath);
    await fs.writeFile(
      path.join(workspace, "IDENTITY.md"),
      "- Avatar: avatars/fallback.png\n",
      "utf-8",
    );

    await expectLocalAvatarPath(avatarConfig(), workspace, path.join("avatars", "fallback.png"));
  });

  it("returns missing for non-existent local avatar files", async () => {
    const resolved = resolveAgentAvatar(avatarConfig("avatars/missing.png"), "main");
    expect(resolved).toMatchObject({
      kind: "none",
      reason: "missing",
      source: "avatars/missing.png",
    });
    expect(resolvePublicAgentAvatarSource(resolved)).toBe("avatars/missing.png");
  });

  it("redacts unsafe public avatar sources", async () => {
    const outsidePath = path.join(root, "outside.png");
    await writeFile(outsidePath);

    const absolute = resolveAgentAvatar(avatarConfig(outsidePath), "main");
    expect(absolute).toMatchObject({ kind: "none", reason: "outside_workspace" });
    expect(resolvePublicAgentAvatarSource(absolute)).toBeUndefined();

    expect(
      resolvePublicAgentAvatarSource({
        kind: "remote",
        source: "https://example.com/avatar.png?token=secret",
      }),
    ).toBe("remote URL");
    expect(
      resolvePublicAgentAvatarSource({
        kind: "data",
        source: "data:image/png;base64,aaaaaaaa",
      }),
    ).toBe("data:image/png;base64,...");
    expect(
      resolvePublicAgentAvatarSource({
        kind: "none",
        source: "../secret.png",
      }),
    ).toBeUndefined();
    expect(
      resolvePublicAgentAvatarSource({
        kind: "none",
        source: "file:///Users/test/private/avatar.png",
      }),
    ).toBeUndefined();
  });

  it("rejects local avatars larger than max bytes", async () => {
    const avatarPath = path.join(workspace, "avatars", "too-big.png");
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.writeFile(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES + 1));

    expect(resolveAgentAvatar(avatarConfig("avatars/too-big.png"), "main")).toMatchObject({
      kind: "none",
      reason: "too_large",
    });
  });

  it("accepts remote and data avatars", () => {
    expect(
      resolveAgentAvatar(avatarConfig("https://example.com/avatar.png"), "main"),
    ).toMatchObject({
      kind: "remote",
      source: "https://example.com/avatar.png",
    });
    expect(resolveAgentAvatar(avatarConfig("data:image/png;base64,aaaa"), "main")).toMatchObject({
      kind: "data",
      source: "data:image/png;base64,aaaa",
    });
  });
});
