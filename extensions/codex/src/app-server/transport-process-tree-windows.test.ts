import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

describe("Codex app-server Windows process-tree termination", () => {
  let terminateProcessTree: typeof import("./transport.js").terminateCodexAppServerTransportProcessTreeAndWait;

  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    ({ terminateCodexAppServerTransportProcessTreeAndWait: terminateProcessTree } =
      await import("./transport.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
  });

  it("uses taskkill to terminate the app-server descendant tree", async () => {
    let alive = true;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0 && alive) {
        return true;
      }
      throw new Error("process is not alive");
    });
    const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
    spawnMock.mockImplementation(() => {
      alive = false;
      queueMicrotask(() => taskkill.emit("close", 0));
      return taskkill;
    });

    await expect(
      terminateProcessTree({ pid: 4321, processGroupOwned: false } as never, {
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/T", "/PID", "4321"],
      expect.objectContaining({ stdio: "ignore", windowsHide: true }),
    );
  });
});
