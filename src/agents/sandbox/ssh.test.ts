import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecRemoteCommand,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  type SshSandboxSession,
} from "./ssh.js";

const sessions: SshSandboxSession[] = [];

afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async (session) => {
      await disposeSshSandboxSession(session);
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
});
