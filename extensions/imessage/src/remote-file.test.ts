import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const warnMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({ warn: warnMock }),
}));

import { withIMessageRemoteFile } from "./remote-file.js";

function result(
  overrides: Partial<{
    code: number | null;
    stdout: string;
    stderr: string;
    termination: "exit" | "timeout" | "signal" | "no-output-timeout";
  }> = {},
) {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit" as const,
    noOutputTimedOut: false,
    ...overrides,
  };
}

describe("withIMessageRemoteFile", () => {
  beforeEach(() => {
    warnMock.mockReset();
  });

  it.each(["allocation", "upload"] as const)(
    "stops later work after retirement during %s and still cleans the remote directory",
    async (phase) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const retired = new Error("iMessage delivery retired");
      let current = true;
      const runCommand = vi.fn(async (argv: string[]) => {
        const isHeldCommand = phase === "allocation" ? argv[0] === "ssh" : argv[0] === "scp";
        if (current && isHeldCommand) {
          entered.resolve();
          await release.promise;
        }
        return result();
      });
      const use = vi.fn(async () => "sent");
      const settled = withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/synthetic.pdf",
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw retired;
          }
        },
        deps: { runCommand, createToken: () => "0123456789abcdef0123456789abcdef" },
        use,
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(
          await Promise.race([entered.promise.then(() => true), settled.then(() => false)]),
        ).toBe(true);
        current = false;
      } finally {
        release.resolve();
        await settled;
      }
      expect(await settled).toEqual({ error: retired });
      expect(runCommand.mock.calls.map(([argv]) => argv[0])).toEqual(
        phase === "allocation" ? ["ssh", "ssh"] : ["ssh", "scp", "ssh"],
      );
      expect(use).not.toHaveBeenCalled();
    },
  );

  it("does not allocate or clean a directory when authority is already retired", async () => {
    const runCommand = vi.fn(async () => result());
    const use = vi.fn(async () => "sent");
    await expect(
      withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/synthetic.pdf",
        assertDirectAdapterHandoff: () => {
          throw new Error("iMessage delivery retired");
        },
        deps: { runCommand },
        use,
      }),
    ).rejects.toThrow("iMessage delivery retired");
    expect(runCommand).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
  });

  it("uploads into an owner-only remote directory and cleans after success", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());
    const use = vi.fn(async () => "sent");

    await expect(
      withIMessageRemoteFile({
        remoteHost: "bot@messages-mac",
        localPath: "/gateway/private/a file;$(touch nope).png",
        deps: { runCommand, createToken: () => "a1b2c3d4e5f60718293a4b5c6d7e8f90" },
        use,
      }),
    ).resolves.toBe("sent");

    expect(runCommand.mock.calls.map(([argv]) => argv[0])).toEqual(["ssh", "scp", "ssh"]);
    expect(runCommand.mock.calls[0]?.[0].at(-1)).toBe("sh -s");
    expect(runCommand.mock.calls[0]?.[1].input).toContain("umask 077");
    expect(runCommand.mock.calls[0]?.[1].input).not.toContain("a file");
    expect(runCommand.mock.calls[1]?.[0]).toEqual([
      "scp",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "--",
      "/gateway/private/a file;$(touch nope).png",
      "bot@messages-mac:/tmp/openclaw-imessage-a1b2c3d4e5f60718293a4b5c6d7e8f90/a-file-touch-nope-.png",
    ]);
    expect(use).toHaveBeenCalledWith(
      "/tmp/openclaw-imessage-a1b2c3d4e5f60718293a4b5c6d7e8f90/a-file-touch-nope-.png",
    );
    expect(runCommand.mock.calls[2]?.[1].input).toBe(
      "set -eu\nrm -rf -- /tmp/openclaw-imessage-a1b2c3d4e5f60718293a4b5c6d7e8f90\n",
    );
  });

  it("cleans after the remote file consumer fails", async () => {
    const message = "rpc failure";
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());

    await expect(
      withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/file.pdf",
        deps: { runCommand, createToken: () => "0123456789abcdef0123456789abcdef" },
        use: async () => {
          throw new Error(message);
        },
      }),
    ).rejects.toThrow(message);
    expect(runCommand.mock.calls.map(([argv]) => argv[0])).toEqual(["ssh", "scp", "ssh"]);
  });

  it("cleans when upload fails", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ code: 1, stderr: "upload failed" }))
      .mockResolvedValueOnce(result());

    await expect(
      withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/file.pdf",
        deps: { runCommand, createToken: () => "0123456789abcdef0123456789abcdef" },
        use: async () => "unused",
      }),
    ).rejects.toThrow("upload failed");
    expect(runCommand.mock.calls.map(([argv]) => argv[0])).toEqual(["ssh", "scp", "ssh"]);
  });

  it("cleans the token-owned parent after setup timeout", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result({ code: null, termination: "timeout" }))
      .mockResolvedValueOnce(result());

    await expect(
      withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/file.pdf",
        deps: { runCommand, createToken: () => "0123456789abcdef0123456789abcdef" },
        use: async () => "unused",
      }),
    ).rejects.toThrow("allocation failed (timeout)");
    expect(runCommand.mock.calls.map(([argv]) => argv[0])).toEqual(["ssh", "ssh"]);
    expect(runCommand.mock.calls[1]?.[1].input).toContain(
      "rm -rf -- /tmp/openclaw-imessage-0123456789abcdef0123456789abcdef",
    );
  });

  it("warns once without replacing a successful result when cleanup fails", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ code: 1, stderr: "cleanup failed" }));

    await expect(
      withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/file.pdf",
        deps: { runCommand, createToken: () => "0123456789abcdef0123456789abcdef" },
        use: async () => "accepted",
      }),
    ).resolves.toBe("accepted");
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
  });

  it("warns once without replacing the primary failure when cleanup also fails", async () => {
    const primary = new Error("RPC failed");
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ code: 1, stderr: "cleanup failed" }));

    await expect(
      withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/file.pdf",
        deps: { runCommand, createToken: () => "0123456789abcdef0123456789abcdef" },
        use: async () => {
          throw primary;
        },
      }),
    ).rejects.toBe(primary);
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
  });

  it("rejects invalid generated tokens before spawning", async () => {
    const runCommand = vi.fn();
    await expect(
      withIMessageRemoteFile({
        remoteHost: "messages-mac",
        localPath: "/gateway/file.pdf",
        deps: { runCommand, createToken: () => "../escape" },
        use: async () => "unused",
      }),
    ).rejects.toThrow("invalid temporary token");
    expect(runCommand).not.toHaveBeenCalled();
  });
});
