// Exercises agent avatar resolution, workspace containment, and public redaction.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  // Compare realpaths so symlinks or temp-dir normalization cannot hide an
  // avatar escaping the configured workspace.
  const workspaceReal = await fs.realpath(workspace);
  const resolved = resolveAgentAvatar(cfg, "main");
  expect(resolved.kind).toBe("local");
  if (resolved.kind === "local") {
    const resolvedReal = await fs.realpath(resolved.filePath);
    expect(path.relative(workspaceReal, resolvedReal)).toBe(expectedRelativePath);
  }
}

const tempRoots: string[] = [];

async function createTempAvatarRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("resolveAgentAvatar", () => {
  it("falls back to IDENTITY.md when config has no avatar", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "avatars", "fallback.png");
    await writeFile(avatarPath);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "IDENTITY.md"),
      "- Avatar: avatars/fallback.png\n",
      "utf-8",
    );

    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace } },
      },
    };

    await expectLocalAvatarPath(cfg, workspace, path.join("avatars", "fallback.png"));
  });

  it("returns missing for non-existent local avatar files", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });

    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace, identity: { avatar: "avatars/missing.png" } } },
      },
    };

    const resolved = resolveAgentAvatar(cfg, "main");
    expect(resolved.kind).toBe("none");
    if (resolved.kind === "none") {
      expect(resolved.reason).toBe("missing");
      expect(resolved.source).toBe("avatars/missing.png");
      expect(resolvePublicAgentAvatarSource(resolved)).toBe("avatars/missing.png");
    }
  });

  it("redacts unsafe public avatar sources", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });
    const outsidePath = path.join(root, "outside.png");
    await writeFile(outsidePath);

    const absolute = resolveAgentAvatar(
      {
        agents: {
          entries: { main: { workspace, identity: { avatar: outsidePath } } },
        },
      },
      "main",
    );
    expect(absolute).toMatchObject({ kind: "none", reason: "outside_workspace" });
    expect(resolvePublicAgentAvatarSource(absolute)).toBeUndefined();

    // Public status/UI surfaces may report remote/data origins, but local
    // absolute paths and traversal attempts stay hidden.
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
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "avatars", "too-big.png");
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.writeFile(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES + 1));

    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace, identity: { avatar: "avatars/too-big.png" } } },
      },
    };

    const resolved = resolveAgentAvatar(cfg, "main");
    expect(resolved.kind).toBe("none");
    if (resolved.kind === "none") {
      expect(resolved.reason).toBe("too_large");
    }
  });

  it("accepts remote and data avatars", () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { identity: { avatar: "https://example.com/avatar.png" } },
          data: { identity: { avatar: "data:image/png;base64,aaaa" } },
        },
      },
    };

    const remote = resolveAgentAvatar(cfg, "main");
    expect(remote.kind).toBe("remote");
    if (remote.kind === "remote") {
      expect(remote.source).toBe("https://example.com/avatar.png");
    }

    const data = resolveAgentAvatar(cfg, "data");
    expect(data.kind).toBe("data");
    if (data.kind === "data") {
      expect(data.source).toBe("data:image/png;base64,aaaa");
    }
  });
});
