import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  tempWorkspaceSync,
  type CreateSandboxBackendParams,
  type SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createSrtSandboxBackendFactory, shutdownSrtSandboxRuntime } from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";

type BridgeContext = Parameters<NonNullable<SandboxBackendHandle["createFsBridge"]>>[0]["sandbox"];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await shutdownSrtSandboxRuntime();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe.skipIf(process.platform !== "darwin")(
  "real scope permissions across commands and file tools",
  () => {
    it.each(
      (["none", "ro", "rw"] as const).flatMap((access) =>
        [false, true].map((perSessionNetwork) => ({ access, perSessionNetwork })),
      ),
    )(
      "preserves $access permissions with broker=$perSessionNetwork despite broad extras",
      async ({ access, perSessionNetwork }) => {
        const fixture = tempWorkspaceSync({ rootDir: tmpdir(), prefix: "srt-permissions-" });
        cleanups.push(() => {
          fixture.cleanup();
        });
        const workspaceDir = fixture.path("private");
        const agentWorkspaceDir = fixture.path("agent");
        const skillsWorkspaceDir = fixture.path("managed");
        const reference = fixture.path("reference");
        const skillRoot = path.join(
          access === "rw" ? agentWorkspaceDir : workspaceDir,
          ".agents",
          "skills",
        );
        for (const dir of [
          workspaceDir,
          agentWorkspaceDir,
          skillRoot,
          path.join(skillsWorkspaceDir, "skills"),
          reference,
        ]) {
          mkdirSync(dir, { recursive: true });
        }
        const hostSeed = path.join(agentWorkspaceDir, "seed.txt");
        writeFileSync(hostSeed, "host-seed");
        const protectedSeed = path.join(skillRoot, "seed.txt");
        writeFileSync(protectedSeed, "protected-seed");
        const resourceSeed = path.join(reference, "seed.txt");
        writeFileSync(resourceSeed, "resource-seed");
        const readOnlyResourceMounts = [{ hostPath: reference, containerPath: reference }];
        const factory = createSrtSandboxBackendFactory({
          pluginConfig: resolveSrtPluginConfig({ writablePaths: [fixture.dir], perSessionNetwork }),
        });
        const params: CreateSandboxBackendParams = {
          sessionKey: "permissions",
          scopeKey: "permissions",
          workspaceDir,
          agentWorkspaceDir,
          skillsWorkspaceDir,
          readOnlyResourceMounts,
          cfg: {
            mode: "all",
            backend: "srt",
            scope: "session",
            workspaceAccess: access,
            workspaceRoot: workspaceDir,
            dockerTmpfsSource: "default",
            docker: { workdir: workspaceDir, env: {} },
            ssh: {},
            browser: {},
            tools: {},
            prune: {},
          } as unknown as CreateSandboxBackendParams["cfg"],
        };
        const handle = await factory(params);
        const bridge = handle.createFsBridge!({
          sandbox: {
            workspaceDir,
            agentWorkspaceDir,
            skillsWorkspaceDir,
            workspaceAccess: access,
            readOnlyResourceMounts,
            containerName: "permissions",
            containerWorkdir: workspaceDir,
            docker: {},
          } as BridgeContext,
        });
        const commandWrite = (target: string) =>
          handle.runShellCommand({ script: `printf changed > '${target}'`, allowFailure: true });
        const hostResult = await commandWrite(hostSeed);
        expect(hostResult.code === 0).toBe(access === "rw");
        if (access === "rw") {
          await bridge.writeFile({ filePath: hostSeed, data: "host-allowed" });
        } else {
          await expect(
            bridge.writeFile({ filePath: hostSeed, data: "host-denied" }),
          ).rejects.toThrow();
          expect(readFileSync(hostSeed, "utf8")).toBe("host-seed");
        }
        const privateTarget = path.join(workspaceDir, "scratch.txt");
        expect((await commandWrite(privateTarget)).code === 0).toBe(access !== "ro");
        if (access === "ro") {
          await expect(
            bridge.writeFile({ filePath: privateTarget, data: "denied" }),
          ).rejects.toThrow();
        } else {
          await bridge.writeFile({ filePath: privateTarget, data: "approved" });
          expect(readFileSync(privateTarget, "utf8")).toBe("approved");
        }
        for (const target of [protectedSeed, resourceSeed]) {
          expect((await commandWrite(target)).code).not.toBe(0);
          await expect(bridge.writeFile({ filePath: target, data: "denied" })).rejects.toThrow();
        }
        expect(readFileSync(protectedSeed, "utf8")).toBe("protected-seed");
        expect(readFileSync(resourceSeed, "utf8")).toBe("resource-seed");
        expect(
          (
            await handle.runShellCommand({
              script: `mv '${path.dirname(skillRoot)}' '${fixture.path("moved")}'`,
              allowFailure: true,
            })
          ).code,
        ).not.toBe(0);
        const alias = fixture.path("host-alias");
        symlinkSync(agentWorkspaceDir, alias);
        if (access !== "rw") {
          expect((await commandWrite(path.join(alias, "seed.txt"))).code).not.toBe(0);
          await expect(
            bridge.writeFile({ filePath: path.join(alias, "seed.txt"), data: "denied" }),
          ).rejects.toThrow();
        }
        await expect(
          bridge.remove({ filePath: path.dirname(skillRoot), recursive: true }),
        ).rejects.toThrow();
        await expect(
          bridge.rename!({ from: path.dirname(skillRoot), to: fixture.path("moved") }),
        ).rejects.toThrow();
        if (access === "none") {
          expect(
            (await handle.runShellCommand({ script: `cat '${hostSeed}'`, allowFailure: true }))
              .code,
          ).not.toBe(0);
          await expect(bridge.readFile({ filePath: hostSeed })).rejects.toThrow();
          await expect(
            bridge.readFile({ filePath: path.join(alias, "seed.txt") }),
          ).rejects.toThrow();
          await expect(
            bridge.copyFile!({
              sourcePath: hostSeed,
              destinationPath: path.join(workspaceDir, "copied.txt"),
            }),
          ).rejects.toThrow();
        } else {
          expect((await bridge.readFile({ filePath: hostSeed })).length).toBeGreaterThan(0);
        }
      },
    );
  },
);
