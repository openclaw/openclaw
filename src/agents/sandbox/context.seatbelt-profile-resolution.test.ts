import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxContext } from "./context.js";

function createSeatbeltConfig(params: {
  profileDir: string;
  profile: string;
  workspaceAccess?: "none" | "ro" | "rw";
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "seatbelt",
          workspaceAccess: params.workspaceAccess ?? "rw",
          seatbelt: {
            profileDir: params.profileDir,
            profile: params.profile,
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolveSeatbeltContextConfig profile handling", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (target) => {
        await fs.chmod(target, 0o755).catch(() => undefined);
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      }),
    );
  });

  it("does not require profileDir writes when profile already exists", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-profile-ro-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-work-"));
    cleanupPaths.push(profileDir, workspaceDir);

    const profilePath = path.join(profileDir, "custom.sb");
    await fs.writeFile(profilePath, '(version 1)\n(allow default)\n', "utf8");
    await fs.chmod(profileDir, 0o555);

    const context = await resolveSandboxContext({
      config: createSeatbeltConfig({ profileDir, profile: "custom" }),
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    expect(context?.backend).toBe("seatbelt");
    expect(context?.seatbelt?.profilePath).toBe(profilePath);
  });

  it("best-effort installs demo profiles when requested profile is missing", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-profile-install-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-work-"));
    cleanupPaths.push(profileDir, workspaceDir);

    const context = await resolveSandboxContext({
      config: createSeatbeltConfig({ profileDir, profile: "demo-open" }),
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    expect(context?.backend).toBe("seatbelt");
    await expect(fs.access(path.join(profileDir, "demo-open.sb"))).resolves.toBeUndefined();
  });

  it("throws a clear error when profile is still missing after best-effort install", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-profile-missing-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-work-"));
    cleanupPaths.push(profileDir, workspaceDir);

    const contextPromise = resolveSandboxContext({
      config: createSeatbeltConfig({ profileDir, profile: "custom-missing" }),
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    await expect(contextPromise).rejects.toThrow(/Seatbelt profile "custom-missing" not found/);
    await expect(contextPromise).rejects.toThrow(/openclaw doctor/);

    const profileDirEntries = await fs.readdir(profileDir);
    expect(profileDirEntries).toEqual([]);
  });
});
