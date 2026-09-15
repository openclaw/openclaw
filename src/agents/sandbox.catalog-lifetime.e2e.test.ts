import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveSandboxSkillRuntimeInputs } from "./embedded-agent-runner/sandbox-skills.js";
import { resolveSandboxContext } from "./sandbox/context.js";
import { releasePublishedSandboxSkills } from "./sandbox/published-skills-handoff.js";

const exec = promisify(execFile);
it("keeps A/B/C complete in one live agent-scoped sandbox and reclaims only released catalogs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-catalog-lifetime-"));
  const workspace = path.join(root, "workspace");
  const skill = path.join(workspace, "skills", "demo");
  // The existing mounted workspace is traversable; only source skill contents are private.
  await fs.mkdir(workspace, { recursive: true });
  await fs.chmod(workspace, 0o755);
  await fs.mkdir(skill, { recursive: true, mode: 0o700 });
  // Exercise lifetime in an existing workspace. Fresh Docker bind-target ownership is #96028.
  await fs.mkdir(path.join(workspace, ".openclaw", "sandbox-skills", "skills"), {
    recursive: true,
  });
  const aOwner = {};
  const bOwner = {};
  const cOwner = {};
  const owners = [aOwner, bOwner, cOwner];
  const containers = new Set<string>();
  try {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
      },
      async () => {
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              workspace,
              sandbox: {
                mode: "all",
                scope: "agent",
                workspaceAccess: "rw",
                workspaceRoot: path.join(root, "sandboxes"),
                docker: { image: "openclaw-sandbox:bookworm-slim" },
                browser: { enabled: false },
                prune: { idleHours: 0, maxAgeDays: 0 },
              },
            },
          },
        };
        const start = async (owner: object, version: string) => {
          await fs.writeFile(
            path.join(skill, "SKILL.md"),
            `---\nname: demo\ndescription: ${version}\n---\n${version}\n`,
            { mode: 0o600 },
          );
          await fs.writeFile(path.join(skill, "companion.txt"), version, { mode: 0o600 });
          bumpSkillsSnapshotVersion({ workspaceDir: workspace });
          const sandbox = await resolveSandboxContext({
            skillsOwner: owner,
            config,
            agentId: "main",
            sessionKey: "agent:main:catalog-lifetime-proof",
            workspaceDir: workspace,
          });
          expect(sandbox?.enabled).toBe(true);
          if (!sandbox) {
            throw new Error("sandbox missing");
          }
          containers.add(sandbox.containerName);
          const inputs = resolveSandboxSkillRuntimeInputs({
            sandbox,
            skillsAnchorWorkspace: workspace,
          });
          const readPath = inputs.skillUsagePaths?.find((p) => p.skillName === "demo")?.readPath;
          expect(inputs.skillsSnapshot?.prompt).toContain(`<description>${version}</description>`);
          if (!readPath) {
            throw new Error("catalog missing demo path");
          }
          return { sandbox, readPath };
        };
        const a = await start(aOwner, "A");
        const original = (
          await exec("docker", ["exec", a.sandbox.containerName, "cat", a.readPath])
        ).stdout;
        expect((await fs.stat(workspace)).mode & 0o777).toBe(0o755);
        expect((await fs.stat(skill)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.join(skill, "SKILL.md"))).mode & 0o777).toBe(0o600);
        const exportedModes = (
          await exec("docker", [
            "exec",
            a.sandbox.containerName,
            "stat",
            "-c",
            "%a",
            "/workspace",
            path.posix.dirname(a.readPath),
            a.readPath,
          ])
        ).stdout
          .trim()
          .split("\n");
        expect(exportedModes).toEqual(["755", "755", "444"]);
        // An existing sandbox may use a configured UID different from the host owner.
        expect(
          (
            await exec("docker", [
              "exec",
              "--user",
              "65534:65534",
              a.sandbox.containerName,
              "cat",
              a.readPath,
            ])
          ).stdout,
        ).toBe(original);
        const b = await start(bOwner, "B");
        const c = await start(cOwner, "C");
        expect(containers.size).toBe(1);
        expect(
          (
            await exec("docker", [
              "exec",
              "--user",
              "65534:65534",
              a.sandbox.containerName,
              "cat",
              path.posix.join(path.posix.dirname(a.readPath), "companion.txt"),
            ])
          ).stdout,
        ).toBe("A");
        expect(
          (await exec("docker", ["exec", a.sandbox.containerName, "cat", a.readPath])).stdout,
        ).toBe(original);
        expect(
          (
            await a.sandbox.fsBridge!.readFile({
              filePath: path.posix.join(path.posix.dirname(a.readPath), "companion.txt"),
            })
          ).toString(),
        ).toBe("A");
        await releasePublishedSandboxSkills(bOwner);
        await expect(
          exec("docker", ["exec", b.sandbox.containerName, "cat", b.readPath]),
        ).rejects.toBeDefined();
        expect(
          (await exec("docker", ["exec", c.sandbox.containerName, "cat", c.readPath])).stdout,
        ).toContain("C");
        expect(
          (await exec("docker", ["exec", a.sandbox.containerName, "cat", a.readPath])).stdout,
        ).toBe(original);
        await releasePublishedSandboxSkills(aOwner);
        await releasePublishedSandboxSkills(aOwner);
        expect((await c.sandbox.fsBridge!.readFile({ filePath: c.readPath })).toString()).toContain(
          "C",
        );
        console.info(
          "SANDBOX_LIFETIME_PROOF",
          JSON.stringify({
            container: c.sandbox.containerName,
            sameContainer: containers.size === 1,
            privateSourcesReadableByNonHostUid: true,
            privateSourceModesPreserved: true,
            exportedModes,
            aReadPath: a.readPath,
            bReadPath: b.readPath,
            cReadPath: c.readPath,
            unreleasedAReadableAcrossBC: true,
            releasedBAbsent: true,
            releasedAIdempotent: true,
            cReadableAfterRelease: true,
          }),
        );
      },
    );
  } catch (error) {
    console.error("SANDBOX_LIFETIME_PRIMARY_FAILURE", error);
    throw error;
  } finally {
    await Promise.all(owners.map((o) => releasePublishedSandboxSkills(o)));
    for (const container of containers) {
      await exec("docker", ["stop", container]);
      await exec("docker", ["rm", container]);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
