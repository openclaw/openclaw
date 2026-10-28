import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecureFileReadResult } from "@openclaw/fs-safe/secure-file";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const custody = vi.hoisted(() => ({
  inspect: vi.fn(),
  read: vi.fn<() => Promise<SecureFileReadResult>>(),
}));
vi.mock("@openclaw/fs-safe/permissions", () => ({ inspectPathPermissions: custody.inspect }));
vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  readSecureFile: custody.read,
}));

import { readGitLabExecToken } from "./gitlab-exec-credential.js";

const privateAcl = {
  ok: true,
  source: "windows-acl",
  ownerTrusted: true,
  worldReadable: false,
  groupReadable: false,
  worldWritable: false,
  groupWritable: false,
};
let platformMock: ReturnType<typeof mockProcessPlatform> | undefined;
let profile: string;

beforeEach(async () => {
  profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-exec-acl-")));
  await fs.writeFile(
    path.join(profile, "config.yml"),
    "hosts:\n  gitlab.example.test:\n    token: synthetic-windows-token\n",
  );
  await fs.chmod(profile, 0o755);
  custody.inspect.mockReset().mockResolvedValue(privateAcl);
  custody.read.mockReset().mockImplementation(async () => {
    const config = path.join(profile, "config.yml");
    return {
      buffer: await fs.readFile(config),
      realPath: config,
      stat: await fs.stat(config),
      exactIdentity: { dev: 0n, ino: 0n },
    };
  });
  platformMock = mockProcessPlatform("win32");
});

afterEach(async () => {
  platformMock?.mockRestore();
  await fs.rm(profile, { recursive: true, force: true });
});

it("uses an owner-only Windows ACL rather than synthetic mode bits", async () => {
  await expect(readGitLabExecToken(profile, "https://gitlab.example.test")).resolves.toBe(
    "synthetic-windows-token",
  );
  expect(custody.inspect).toHaveBeenCalledTimes(2);
});

it.each([
  { reason: "unverified", change: { ok: false } },
  { reason: "unknown source", change: { source: "unknown" } },
  { reason: "other owner", change: { ownerTrusted: false } },
  { reason: "group read", change: { groupReadable: true } },
  { reason: "world read", change: { worldReadable: true } },
  { reason: "group write", change: { groupWritable: true } },
  { reason: "world write", change: { worldWritable: true } },
])("rejects $reason before reading credentials", async ({ change }) => {
  custody.inspect.mockResolvedValue({ ...privateAcl, ...change });
  await expect(readGitLabExecToken(profile, "https://gitlab.example.test")).rejects.toThrow(
    "GitLab Identity credential is unavailable or insecure",
  );
  expect(custody.read).not.toHaveBeenCalled();
});

it("rejects an ACL changed during the file read", async () => {
  custody.inspect
    .mockResolvedValueOnce(privateAcl)
    .mockResolvedValueOnce({ ...privateAcl, worldReadable: true });
  await expect(readGitLabExecToken(profile, "https://gitlab.example.test")).rejects.toThrow(
    "GitLab Identity credential is unavailable or insecure",
  );
  expect(custody.read).toHaveBeenCalledOnce();
});
