import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecureFileReadResult } from "@openclaw/fs-safe/secure-file";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const permissions = vi.hoisted(() => ({
  inspect: vi.fn(),
  read: vi.fn<() => Promise<SecureFileReadResult>>(),
}));
vi.mock("@openclaw/fs-safe/permissions", () => ({ inspectPathPermissions: permissions.inspect }));
vi.mock("../infra/fs-safe.js", () => ({ readSecureFile: permissions.read }));

import { readGitHubExecToken } from "./github-exec-credential.js";
import { writeManagedGitHubProfileFiles } from "./github-tool-profile-files.js";

// Emulate Windows directory ACL inheritance at the fs-safe OS boundary. File
// contents still use the filesystem, so the launcher reads the writer's token.
vi.mock("@openclaw/fs-safe/root", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/root")>();
  return {
    ...actual,
    root: async (directory: string) => ({
      mkdir: async (relativePath: string, options: { private?: boolean }) => {
        await fs.mkdir(path.join(directory, relativePath), { recursive: true });
        if (options.private) {
          permissions.inspect.mockResolvedValue(privateAcl);
        }
      },
      write: async (relativePath: string, content: string) => {
        await fs.writeFile(path.join(directory, relativePath), content);
      },
    }),
  };
});

let platformMock: ReturnType<typeof mockProcessPlatform> | undefined;
let profileDir: string;
const privateAcl = {
  ok: true,
  source: "windows-acl",
  ownerTrusted: true,
  worldReadable: false,
  groupReadable: false,
  worldWritable: false,
  groupWritable: false,
};

async function readHosts(): Promise<SecureFileReadResult> {
  const hosts = path.join(profileDir, "hosts.yml");
  const identity = await fs.stat(hosts, { bigint: true });
  return {
    buffer: await fs.readFile(hosts),
    realPath: hosts,
    stat: await fs.stat(hosts),
    exactIdentity: { dev: identity.dev, ino: identity.ino },
  };
}

const expectUnavailable = () =>
  expect(readGitHubExecToken(profileDir)).rejects.toThrow(
    "GitHub Identity credential is unavailable or insecure",
  );

beforeEach(async () => {
  profileDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "github-exec-acl-")));
  // Windows admission must use ACLs, not Node's synthetic POSIX mode bits.
  await fs.chmod(profileDir, 0o755);
  const hosts = path.join(profileDir, "hosts.yml");
  await fs.writeFile(hosts, "github.com:\n  oauth_token: synthetic-windows-token\n", {
    mode: 0o600,
  });
  permissions.inspect.mockReset().mockResolvedValue(privateAcl);
  permissions.read.mockReset().mockImplementation(readHosts);
  platformMock = mockProcessPlatform("win32");
});

afterEach(async () => {
  platformMock?.mockRestore();
  platformMock = undefined;
  await fs.rm(profileDir, { recursive: true, force: true });
});

describe("GitHub exec Windows directory ownership", () => {
  it("creates a launchable profile beneath an inherited non-private Windows directory", async () => {
    await fs.rm(profileDir, { recursive: true });
    permissions.inspect.mockResolvedValue({ ...privateAcl, groupReadable: true });

    await writeManagedGitHubProfileFiles(profileDir, {
      login: "worker-fixture",
      token: "synthetic-worker-token",
    });
    // A private Windows ACL, not synthetic POSIX mode bits, admits the profile.
    await fs.chmod(profileDir, 0o755);
    await expect(readGitHubExecToken(profileDir)).resolves.toBe("synthetic-worker-token");
    // Credential renewal must keep the private directory and replace the token.
    await writeManagedGitHubProfileFiles(profileDir, {
      login: "worker-fixture",
      token: "synthetic-renewed-token",
    });
    await expect(readGitHubExecToken(profileDir)).resolves.toBe("synthetic-renewed-token");
  });

  it.each([
    { reason: "unverified", change: { ok: false } },
    { reason: "unknown source", change: { source: "unknown" } },
    { reason: "different owner", change: { ownerTrusted: false } },
    { reason: "group read", change: { groupReadable: true } },
    { reason: "world read", change: { worldReadable: true } },
    { reason: "group write", change: { groupWritable: true } },
    { reason: "world write", change: { worldWritable: true } },
  ])("rejects $reason before reading credentials", async ({ change }) => {
    permissions.inspect.mockResolvedValue({ ...privateAcl, ...change });
    await expectUnavailable();
    expect(permissions.read).not.toHaveBeenCalled();
  });

  it("rejects a directory ACL that changes while the file is being read", async () => {
    permissions.inspect
      .mockResolvedValueOnce(privateAcl)
      .mockResolvedValueOnce({ ...privateAcl, worldReadable: true });
    await expectUnavailable();
    expect(permissions.read).toHaveBeenCalledOnce();
  });
});
