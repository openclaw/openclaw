import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  ensureConfiguredSeatbeltDemoProfiles,
  ensureSeatbeltDemoProfiles,
  resolveBundledSeatbeltProfilesDir,
  SEATBELT_DEMO_PROFILE_NAMES,
} from "./seatbelt-profiles.js";

const PROFILE_FILES = SEATBELT_DEMO_PROFILE_NAMES.map((name) => `${name}.sb`);

async function createDemoSourceDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-src-"));
  for (const fileName of PROFILE_FILES) {
    await fs.writeFile(path.join(dir, fileName), `; ${fileName}\n(version 1)\n`, "utf8");
  }
  return dir;
}

describe("seatbelt demo profile installer", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })),
    );
  });

  it("copies bundled demo profiles when missing and does not overwrite existing files", async () => {
    const sourceDir = await createDemoSourceDir();
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-dest-"));
    cleanupPaths.push(sourceDir, profileDir);

    const first = await ensureSeatbeltDemoProfiles({ profileDir, sourceDir });
    expect(first.copied.toSorted()).toEqual(PROFILE_FILES.toSorted());
    expect(first.existing).toEqual([]);
    expect(first.missingSource).toEqual([]);

    const markerPath = path.join(profileDir, "demo-open.sb");
    const markerContents = "; keep me\n(version 1)\n";
    await fs.writeFile(markerPath, markerContents, "utf8");

    const second = await ensureSeatbeltDemoProfiles({ profileDir, sourceDir });
    expect(second.copied).toEqual([]);
    expect(second.existing.toSorted()).toEqual(PROFILE_FILES.toSorted());

    const persisted = await fs.readFile(markerPath, "utf8");
    expect(persisted).toBe(markerContents);
  });

  it("demo-open profile gates writes by WORKSPACE_ACCESS while keeping reads", async () => {
    const bundledDir = resolveBundledSeatbeltProfilesDir();
    expect(bundledDir).not.toBeNull();

    const profile = await fs.readFile(path.join(bundledDir!, "demo-open.sb"), "utf8");
    expect(profile).toContain('(allow file-read* (subpath (param "PROJECT_DIR")))');
    expect(profile).toContain('(allow file-read* (subpath (param "WORKSPACE_DIR")))');
    expect(profile).toContain(
      '(if (string=? (param "WORKSPACE_ACCESS") "rw")\n  (allow file-write* (subpath (param "PROJECT_DIR")))',
    );
    expect(profile).toContain(
      '(if (string=? (param "WORKSPACE_ACCESS") "rw")\n  (allow file-write* (subpath (param "WORKSPACE_DIR")))',
    );
    expect(profile).not.toContain(
      '(allow file-read* file-write* (subpath (param "PROJECT_DIR")))',
    );
    expect(profile).not.toContain(
      '(allow file-read* file-write* (subpath (param "WORKSPACE_DIR")))',
    );
  });

  it("installs profiles for each configured seatbelt profileDir", async () => {
    const sourceDir = await createDemoSourceDir();
    const defaultProfileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-main-"));
    const workerProfileDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-seatbelt-worker-"));
    cleanupPaths.push(sourceDir, defaultProfileDir, workerProfileDir);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            backend: "seatbelt",
            seatbelt: {
              profile: "demo-open",
              profileDir: defaultProfileDir,
            },
          },
        },
        list: [
          {
            id: "worker",
            sandbox: {
              backend: "seatbelt",
              seatbelt: {
                profile: "demo-restricted",
                profileDir: workerProfileDir,
              },
            },
          },
          {
            id: "docker-only",
            sandbox: {
              backend: "docker",
            },
          },
        ],
      },
    } as OpenClawConfig;

    const summary = await ensureConfiguredSeatbeltDemoProfiles({
      cfg,
      sourceDir,
      onWarn: vi.fn(),
    });

    expect(summary.profileDirs.toSorted()).toEqual(
      [defaultProfileDir, workerProfileDir].toSorted(),
    );
    expect(summary.totalCopied).toBe(PROFILE_FILES.length * 2);

    const mainFiles = await fs.readdir(defaultProfileDir);
    const workerFiles = await fs.readdir(workerProfileDir);
    expect(mainFiles.sort()).toEqual(PROFILE_FILES.toSorted());
    expect(workerFiles.sort()).toEqual(PROFILE_FILES.toSorted());
  });
});
