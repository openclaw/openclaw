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
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe("PRIVATE KEY");
    expect(await fs.readFile(`${configDir}/certificate.pub`, "utf8")).toBe("SSH CERT");
    expect(await fs.readFile(`${configDir}/known_hosts`, "utf8")).toBe(
      "example.com ssh-ed25519 AAAATEST",
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
