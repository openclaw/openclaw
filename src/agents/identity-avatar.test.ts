import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { resolveAgentAvatar, resolvePublicAgentAvatarSource } from "./identity-avatar.js";

async function writeFile(filePath: string, contents: string | Uint8Array = "avatar") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf-8");
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

it("falls back to IDENTITY.md when config has no avatar", async () => {
  const avatarPath = path.join(workspace, "avatars", "fallback.png");
  await writeFile(avatarPath);
  await writeFile(path.join(workspace, "IDENTITY.md"), "- Avatar: avatars/fallback.png\n");
  const resolved = resolveAgentAvatar(avatarConfig(), "main");
  expect(resolved.kind).toBe("local");
  if (resolved.kind === "local") {
    expect(path.relative(await fs.realpath(workspace), await fs.realpath(resolved.filePath))).toBe(
      path.join("avatars", "fallback.png"),
    );
  }
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
});

it.each([
  ["remote", "https://example.com/avatar.png?token=secret", "remote URL"],
  ["data", "data:image/png;base64,aaaaaaaa", "data:image/png;base64,..."],
  ["none", "../secret.png", undefined],
  ["none", "file:///Users/test/private/avatar.png", undefined],
] as const)("redacts public %s source %s", (kind, source, expected) => {
  expect(resolvePublicAgentAvatarSource({ kind, source })).toBe(expected);
});

it("rejects local avatars larger than max bytes", async () => {
  const avatarPath = path.join(workspace, "avatars", "too-big.png");
  await writeFile(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES + 1));

  expect(resolveAgentAvatar(avatarConfig("avatars/too-big.png"), "main")).toMatchObject({
    kind: "none",
    reason: "too_large",
  });
});

it.each([
  ["remote", "https://example.com/avatar.png"],
  ["data", "data:image/png;base64,aaaa"],
] as const)("accepts %s avatars", (kind, source) => {
  expect(resolveAgentAvatar(avatarConfig(source), "main")).toMatchObject({ kind, source });
});
