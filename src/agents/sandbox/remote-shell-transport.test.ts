import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { spawnCommand } from "../../process/exec.js";
import { createRemoteShellSandboxSession } from "./remote-shell-transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.platform !== "win32")("provider-owned remote shell transport", () => {
  it("keeps uploads, private exec staging, execution, and cleanup behind the command owner", async () => {
    const root = await fs.realpath(tempDirs.make("remote-shell-owner-"));
    const claimFile = path.join(root, "claim");
    const providerFile = path.join(root, "provider.cjs");
    await fs.writeFile(claimFile, "original");
    await fs.writeFile(
      providerFile,
      `
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
      if (fs.readFileSync(${JSON.stringify(claimFile)}, "utf8") !== "original") {
        process.stderr.write("provider owner changed");
        process.exit(42);
      }
      if (process.env.PROVIDER_LOCAL_ONLY !== "synthetic-provider-auth") process.exit(43);
      const child = spawnSync("/bin/sh", ["-c", process.argv[2]], {
        stdio: "inherit", env: { PATH: process.env.PATH },
      });
      process.exit(child.status ?? 1);
    `,
    );
    const session = createRemoteShellSandboxSession({
      buildCommand: ({ remoteCommand }) => ({
        argv: [process.execPath, providerFile, remoteCommand],
        env: { ...process.env, PROVIDER_LOCAL_ONLY: "synthetic-provider-auth" },
        cwd: root,
      }),
    });
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    await fs.mkdir(localDir);
    const payload = Buffer.from([0, 1, 2, 255]);
    await fs.writeFile(path.join(localDir, "payload"), payload);
    await session.uploadDirectory({ localDir, remoteDir, remoteRootDir: root });
    expect(await fs.readFile(path.join(remoteDir, "payload"))).toEqual(payload);

    const prepared = await session.prepareExec({
      remoteCommand: 'printf "%s:%s" "$EXEC_PRIVATE" "${PROVIDER_LOCAL_ONLY-unset}"',
      env: { EXEC_PRIVATE: "synthetic-exec-private" },
    });
    try {
      expect(prepared.argv.join(" ")).not.toContain("synthetic-exec-private");
      expect(prepared.cwd).toBe(root);
      await fs.writeFile(claimFile, "transferred");
      const refused = await spawnCommand(prepared.argv, {
        baseEnv: prepared.env,
        cwd: prepared.cwd,
        reject: false,
      });
      expect(refused.exitCode).toBe(42);
      expect(refused.stdout).toBe("");
      await fs.writeFile(path.join(localDir, "payload"), "changed after claim transfer");
      await expect(
        session.uploadDirectory({ localDir, remoteDir, remoteRootDir: root }),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(remoteDir, "payload"))).toEqual(payload);
      await fs.writeFile(claimFile, "original");
      const completed = await spawnCommand(prepared.argv, {
        baseEnv: prepared.env,
        cwd: prepared.cwd,
      });
      expect(completed.stdout).toBe("synthetic-exec-private:unset");
    } finally {
      await fs.writeFile(claimFile, "original");
      await prepared.cleanup();
      await session.dispose();
    }
  });
});
