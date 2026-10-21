import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { spawnCommand } from "../../process/exec.js";
import { createRemoteShellSandboxSession } from "./remote-shell-transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionFor = (root: string, argv: (command: string) => string[], env = process.env) =>
  createRemoteShellSandboxSession({
    buildCommand: ({ remoteCommand }) => ({ argv: argv(remoteCommand), env, cwd: root }),
  });

async function uploadFixture(prefix: string, payload: string | Buffer) {
  const root = await fs.realpath(tempDirs.make(prefix));
  const localDir = path.join(root, "local");
  const remoteDir = path.join(root, "remote");
  await fs.mkdir(localDir);
  await fs.writeFile(path.join(localDir, "payload"), payload);
  return { root, localDir, remoteDir, remoteRootDir: root };
}

describe.runIf(process.platform !== "win32")("provider-owned remote shell transport", () => {
  it("keeps uploads, private exec staging, execution, and cleanup behind the command owner", async () => {
    const payload = Buffer.from([0, 1, 2, 255]);
    const upload = await uploadFixture("remote-shell-owner-", payload);
    const { root, localDir, remoteDir } = upload;
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
    const session = sessionFor(root, (command) => [process.execPath, providerFile, command], {
      ...process.env,
      PROVIDER_LOCAL_ONLY: "synthetic-provider-auth",
    });
    await session.uploadDirectory(upload);
    expect(await fs.readFile(path.join(remoteDir, "payload"))).toEqual(payload);

    const prepared = await session.prepareExec({
      remoteCommand: 'printf "%s:%s" "$EXEC_PRIVATE" "${PROVIDER_LOCAL_ONLY-unset}"',
      env: { EXEC_PRIVATE: "synthetic-exec-private" },
    });
    try {
      expect(prepared.argv.join(" ")).not.toContain("synthetic-exec-private");
      expect(prepared.cwd).toBe(root);
      await fs.writeFile(claimFile, "transferred");
      const execute = (reject = true) =>
        spawnCommand(prepared.argv, {
          baseEnv: prepared.env,
          cwd: prepared.cwd,
          reject,
        });
      const refused = await execute(false);
      expect(refused).toMatchObject({ exitCode: 42, stdout: "" });
      await fs.writeFile(path.join(localDir, "payload"), "changed after claim transfer");
      await expect(session.uploadDirectory(upload)).rejects.toThrow();
      expect(await fs.readFile(path.join(remoteDir, "payload"))).toEqual(payload);
      await fs.writeFile(claimFile, "original");
      await expect(execute()).resolves.toMatchObject({ stdout: "synthetic-exec-private:unset" });
    } finally {
      await fs.writeFile(claimFile, "original");
      await prepared.cleanup();
      await session.dispose();
    }
  });

  it("rejects an upload when the remote shell dies from a signal without a status", async () => {
    const upload = await uploadFixture("remote-shell-signal-", "payload-bytes");
    const session = sessionFor(upload.root, () => [
      "/bin/sh",
      "-c",
      'cat >/dev/null; kill -TERM "$$"',
    ]);
    await expect(session.uploadDirectory(upload)).rejects.toThrow(
      "remote exited from signal SIGTERM",
    );
    await session.dispose();
  });
});
