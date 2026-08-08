import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkSignalCliAccount } from "./signal-cli-link.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 1234;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

let child: ReturnType<typeof createMockChild>;

beforeEach(() => {
  child = createMockChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
});

afterEach(() => {
  child.stdout.end();
  child.stderr.end();
  child.removeAllListeners();
});

describe("linkSignalCliAccount", () => {
  it("streams the link URI and returns the associated account", async () => {
    const onLinkUri = vi.fn(async () => undefined);
    const resultPromise = linkSignalCliAccount({
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/var/lib/signal-cli",
      onLinkUri,
    });

    child.stdout.write("sgnl://linkdevice?uuid=test&pub_key=test\n");
    child.stdout.write("Associated with: +15555550123\n");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      associatedAccount: "+15555550123",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "/opt/openclaw/signal-cli",
      ["--config", "/var/lib/signal-cli", "link", "-n", "OpenClaw"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(onLinkUri).toHaveBeenCalledOnce();
    expect(onLinkUri).toHaveBeenCalledWith("sgnl://linkdevice?uuid=test&pub_key=test");
  });

  it("returns signal-cli's error when linking fails", async () => {
    const onLinkUri = vi.fn(async () => undefined);
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri,
    });

    child.stderr.write("Link request timed out, please try again.\n");
    child.emit("close", 1, null);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Link request timed out, please try again.",
    });
    expect(onLinkUri).not.toHaveBeenCalled();
  });
});
