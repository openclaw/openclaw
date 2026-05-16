import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecRemoteCommand,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  type SshSandboxSession,
  uploadDirectoryToSshTarget,
} from "./ssh.js";

const sessions: SshSandboxSession[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async (session) => {
      await disposeSshSandboxSession(session);
    }),
  );
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("sandbox ssh helpers", () => {
  it("materializes inline ssh auth data into a temp config", async () => {
    const session = await createSshSandboxSessionFromSettings({
      command: "ssh",
      target: "peter@example.com:2222",
      strictHostKeyChecking: true,
      updateHostKeys: false,
      identityData: "PRIVATE KEY",
      certificateData: "SSH CERT",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
    sessions.push(session);

    const config = await fs.readFile(session.configPath, "utf8");
    expect(config).toContain("Host openclaw-sandbox");
    expect(config).toContain("HostName example.com");
    expect(config).toContain("User peter");
    expect(config).toContain("Port 2222");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain("UpdateHostKeys no");

    const configDir = session.configPath.slice(0, session.configPath.lastIndexOf("/"));
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe("PRIVATE KEY\n");
    expect(await fs.readFile(`${configDir}/certificate.pub`, "utf8")).toBe("SSH CERT\n");
    expect(await fs.readFile(`${configDir}/known_hosts`, "utf8")).toBe(
      "example.com ssh-ed25519 AAAATEST\n",
    );
  });

  it("normalizes CRLF and escaped-newline private keys before writing temp files", async () => {
    const session = await createSshSandboxSessionFromSettings({
      command: "ssh",
      target: "peter@example.com:2222",
      strictHostKeyChecking: true,
      updateHostKeys: false,
      identityData:
        "-----BEGIN OPENSSH PRIVATE KEY-----\\nbGluZTE=\\r\\nbGluZTI=\\r\\n-----END OPENSSH PRIVATE KEY-----",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
    sessions.push(session);

    const configDir = session.configPath.slice(0, session.configPath.lastIndexOf("/"));
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "bGluZTE=\n" +
        "bGluZTI=\n" +
        "-----END OPENSSH PRIVATE KEY-----\n",
    );
  });

  it("normalizes mixed real and escaped newlines in private keys", async () => {
    const session = await createSshSandboxSessionFromSettings({
      command: "ssh",
      target: "peter@example.com:2222",
      strictHostKeyChecking: true,
      updateHostKeys: false,
      identityData:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nline-1\\nline-2\n-----END OPENSSH PRIVATE KEY-----",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
    sessions.push(session);

    const configDir = session.configPath.slice(0, session.configPath.lastIndexOf("/"));
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "line-1\n" +
        "line-2\n" +
        "-----END OPENSSH PRIVATE KEY-----\n",
    );
  });

  it("wraps remote exec commands with env and workdir", () => {
    const command = buildExecRemoteCommand({
      command: "pwd && printenv TOKEN",
      workdir: "/sandbox/project",
      env: {
        TOKEN: "abc 123",
      },
    });
    expect(command).toContain(`'env'`);
    expect(command).toContain(`'TOKEN=abc 123'`);
    expect(command).toContain(`'cd '"'"'/sandbox/project'"'"' && pwd && printenv TOKEN'`);
  });

  it.runIf(process.platform !== "win32")(
    "rejects upload trees with symlinks that escape the local workspace",
    async () => {
      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-"));
      tempDirs.push(localDir);
      await fs.symlink("/etc", path.join(localDir, "escape"));

      await expect(
        uploadDirectoryToSshTarget({
          session: {
            command: "ssh",
            configPath: "/tmp/openclaw-test-ssh-config",
            host: "openclaw-sandbox",
          },
          localDir,
          remoteDir: "/remote/workspace",
        }),
      ).rejects.toThrow(/refuses symlink escaping the workspace: escape/i);
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows in-workspace symlinks that point to hardlinked files",
    async () => {
      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-safe-"));
      tempDirs.push(localDir);
      const fakeSsh = path.join(localDir, "fake-ssh.sh");
      await fs.writeFile(fakeSsh, "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
      await fs.writeFile(path.join(localDir, "source.txt"), "hello");
      await fs.link(path.join(localDir, "source.txt"), path.join(localDir, "hardlinked.txt"));
      await fs.symlink("source.txt", path.join(localDir, "link.txt"));

      await expect(
        uploadDirectoryToSshTarget({
          session: {
            command: fakeSsh,
            configPath: "/tmp/openclaw-test-ssh-config",
            host: "openclaw-sandbox",
          },
          localDir,
          remoteDir: "/remote/workspace",
        }),
      ).resolves.toBeUndefined();
    },
  );
});
