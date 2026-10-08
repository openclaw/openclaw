import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, tempWorkspaceSync } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSrtFilesystemPolicy } from "./srt-runtime-config.js";

describe.skipIf(process.platform === "win32")("protected filesystem mount boundaries", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of cleanup.splice(0)) {
      dispose();
    }
  });
  it.each(["none", "ro", "rw"] as const)(
    "does not re-admit protected mounts through narrower writable roots for %s",
    (workspaceAccess) => {
      const workspace = tempWorkspaceSync({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "srt-mount-proof-",
      });
      cleanup.push(() => workspace.cleanup());
      const privateDir = workspace.path("private");
      const agentDir = workspace.path("agent");
      const resource = workspace.path("reference");
      const skills = path.join(
        workspaceAccess === "rw" ? agentDir : privateDir,
        ".agents",
        "skills",
      );
      for (const dir of [privateDir, agentDir, resource, skills]) {
        mkdirSync(dir, { recursive: true });
      }
      const alias = workspace.path("reference-alias");
      symlinkSync(resource, alias);
      const nested = [resource + "/future", alias + "/future", skills + "/future"];
      const policy = buildSrtFilesystemPolicy(
        {
          workspaceDir: privateDir,
          agentWorkspaceDir: agentDir,
          workspaceAccess,
          readOnlyResourceMounts: [{ hostPath: resource, containerPath: "/reference" }],
        },
        [workspace.dir, agentDir + "/future", ...nested],
      );
      for (const target of nested) {
        expect(policy.allowWrite).not.toContain(target);
      }
      if (workspaceAccess !== "rw") {
        expect(policy.allowWrite).not.toContain(agentDir + "/future");
      }
      if (workspaceAccess === "none") {
        expect(policy.allowWrite).not.toContain(workspace.dir);
        expect(policy.allowWrite).toContain(privateDir);
      }
      if (workspaceAccess === "ro") {
        expect(policy.allowWrite).not.toContain(privateDir);
      }
    },
  );
});
