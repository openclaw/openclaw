import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { beforeEach, expect, it, vi } from "vitest";

const { warnMock, runCommand, randomUUIDMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  runCommand: vi.fn(),
  randomUUIDMock: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: randomUUIDMock,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandWithTimeout: runCommand,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({ warn: warnMock }),
}));

import { withIMessageRemoteFile } from "./remote-file.js";

const remoteDir = "/tmp/openclaw-imessage-0123456789abcdef0123456789abcdef";
const use = vi.fn(async () => "sent");
function stage(options: Partial<Parameters<typeof withIMessageRemoteFile<string>>[0]> = {}) {
  return withIMessageRemoteFile({
    remoteHost: "messages-mac",
    localPath: "/gateway/file.pdf",
    use,
    ...options,
  });
}

type CommandResult = Pick<SpawnResult, "code" | "stdout" | "stderr" | "termination">;
const success: CommandResult = { code: 0, stdout: "", stderr: "", termination: "exit" };

function respond(...overrides: Partial<CommandResult>[]) {
  for (const override of overrides) {
    runCommand.mockResolvedValueOnce({ ...success, ...override });
  }
}
const commands = () => runCommand.mock.calls.map(([argv]) => argv[0]);

beforeEach(() => {
  warnMock.mockReset();
  runCommand.mockReset();
  use.mockReset().mockResolvedValue("sent");
  randomUUIDMock.mockReturnValue("01234567-89ab-cdef-0123-456789abcdef");
});

it.each(["allocation", "upload"] as const)("retires during %s", async (phase) => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const retired = new Error("iMessage delivery retired");
  let current = true;
  runCommand.mockImplementation(async (argv: string[]) => {
    if (current && argv[0] === (phase === "allocation" ? "ssh" : "scp")) {
      entered.resolve();
      await release.promise;
    }
    return success;
  });
  const settled = stage({
    assertDirectAdapterHandoff: () => {
      if (!current) {
        throw retired;
      }
    },
  }).catch((error: unknown) => error);
  try {
    expect(await Promise.race([entered.promise.then(() => true), settled.then(() => false)])).toBe(
      true,
    );
    current = false;
  } finally {
    release.resolve();
    await settled;
  }
  expect(await settled).toBe(retired);
  expect(commands()).toEqual(phase === "allocation" ? ["ssh", "ssh"] : ["ssh", "scp", "ssh"]);
  expect(use).not.toHaveBeenCalled();
});

it("does not allocate or clean a directory when authority is already retired", async () => {
  runCommand.mockResolvedValue(success);
  await expect(
    stage({
      assertDirectAdapterHandoff: () => {
        throw new Error("iMessage delivery retired");
      },
    }),
  ).rejects.toThrow("iMessage delivery retired");
  expect(runCommand).not.toHaveBeenCalled();
  expect(use).not.toHaveBeenCalled();
});

it("uploads into an owner-only remote directory and cleans after success", async () => {
  respond({}, {}, {});
  const localPath = "/gateway/private/a file;$(touch nope).png";
  const remotePath = `${remoteDir}/a-file-touch-nope-.png`;

  await expect(stage({ remoteHost: "bot@messages-mac", localPath })).resolves.toBe("sent");

  const [allocate, upload, cleanup] = runCommand.mock.calls;
  expect(commands()).toEqual(["ssh", "scp", "ssh"]);
  expect(allocate?.[0].at(-1)).toBe("sh -s");
  expect(allocate?.[1].input).toContain("umask 077");
  expect(allocate?.[1].input).not.toContain("a file");
  expect(upload?.[0]).toEqual([
    "scp",
    ..."BatchMode=yes StrictHostKeyChecking=yes ConnectTimeout=10 ClearAllForwardings=yes ForwardAgent=no ForwardX11=no"
      .split(" ")
      .flatMap((option) => ["-o", option]),
    "--",
    localPath,
    `bot@messages-mac:${remotePath}`,
  ]);
  expect(use).toHaveBeenCalledWith(remotePath);
  expect(cleanup?.[1].input).toBe(`set -eu\nrm -rf -- ${remoteDir}\n`);
});

it("cleans the token-owned parent after setup timeout", async () => {
  respond({ code: null, termination: "timeout" }, {});

  await expect(stage()).rejects.toThrow("allocation failed (timeout)");
  expect(commands()).toEqual(["ssh", "ssh"]);
  expect(runCommand.mock.calls[1]?.[1].input).toContain(`rm -rf -- ${remoteDir}`);
});

it("warns once without replacing the primary failure when cleanup also fails", async () => {
  const primary = new Error("RPC failed");
  respond({}, {}, { code: 1, stderr: "cleanup failed" });
  use.mockRejectedValueOnce(primary);
  await expect(stage()).rejects.toBe(primary);
  expect(warnMock).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("cleanup failed"));
});
