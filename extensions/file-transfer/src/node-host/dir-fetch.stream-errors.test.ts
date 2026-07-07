// File Transfer tests cover dir fetch child-output failures.
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: () => void };
  stdout: EventEmitter;
};

function mockSpawn(script: (child: MockChild) => void, startOnStdin = false) {
  return vi.fn(() => {
    const child = new EventEmitter() as MockChild;
    child.kill = vi.fn();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as MockChild["stdin"];
    child.stdout = new EventEmitter();
    child.stdin.end = () => {
      if (startOnStdin) {
        queueMicrotask(() => script(child));
      }
    };
    if (!startOnStdin) {
      queueMicrotask(() => script(child));
    }
    return child;
  });
}

async function importWithSpawn(spawnMock: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return { ...actual, spawn: spawnMock };
  });
  return await import("./dir-fetch.js");
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("dir.fetch child output lifecycle", () => {
  it.runIf(process.platform !== "win32")(
    "returns READ_ERROR when real tar archive stdout fails",
    async () => {
      const tempPath = path.join(os.tmpdir(), `dir-fetch-stream-error-${crypto.randomUUID()}`);
      await fs.mkdir(tempPath);
      const tmpRoot = await fs.realpath(tempPath);
      await fs.writeFile(path.join(tmpRoot, "payload.bin"), Buffer.alloc(1024 * 1024, 1));
      vi.resetModules();
      vi.doMock("node:child_process", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:child_process")>();
        return {
          ...actual,
          spawn: vi.fn(
            (
              command: string,
              args: readonly string[],
              options: Parameters<typeof actual.spawn>[2],
            ) => {
              const child = actual.spawn(command, [...args], options);
              if (command === "/usr/bin/tar" && args[0] === "-czf") {
                const stdout = child.stdout;
                if (!stdout) {
                  throw new Error("expected piped tar stdout");
                }
                queueMicrotask(() => stdout.destroy(new Error("injected archive read failure")));
              }
              return child;
            },
          ),
        };
      });

      try {
        const { handleDirFetch } = await import("./dir-fetch.js");
        await expect(handleDirFetch({ path: tmpRoot })).resolves.toMatchObject({
          ok: false,
          code: "READ_ERROR",
          message: "tar command failed",
        });
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );

  it("stops a broken du read and falls back to capped tar", async () => {
    const spawnMock = mockSpawn((child) => {
      child.stdout.emit("error", new Error("du read failed"));
      child.emit("close", 0);
    });
    const { testing } = await importWithSpawn(spawnMock);

    await expect(testing.preflightDu("/tmp/project", 1024)).resolves.toBe(true);
    expect(spawnMock.mock.results[0]?.value.kill).toHaveBeenCalledOnce();
  });

  it("fails tar entry listing closed on stdout errors", async () => {
    const spawnMock = mockSpawn((child) => {
      child.stdout.emit("data", Buffer.from("partial.txt\n"));
      child.stdout.emit("error", new Error("listing read failed"));
      child.emit("close", 0);
    }, true);
    const { testing } = await importWithSpawn(spawnMock);

    await expect(testing.listTarEntries(Buffer.from("archive"))).resolves.toBeNull();
    expect(spawnMock.mock.results[0]?.value.kill).toHaveBeenCalledOnce();
  });

  it("fails archive creation closed on stdout errors", async () => {
    const spawnMock = mockSpawn((child) => {
      child.stdout.emit("data", Buffer.from("partial archive"));
      child.stdout.emit("error", new Error("archive read failed"));
      child.emit("close", 0);
    });
    const { testing } = await importWithSpawn(spawnMock);

    await expect(testing.createTarArchive("/tmp/project", 1024)).resolves.toBe("ERROR");
    expect(spawnMock.mock.results[0]?.value.kill).toHaveBeenCalledOnce();
  });
});
