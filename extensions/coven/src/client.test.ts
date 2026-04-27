import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CovenApiError, createCovenClient } from "./client.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coven-client-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function withServer(
  handler: http.RequestListener,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const socketPath = path.join(tmpDir, "coven.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    await fn(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("createCovenClient", () => {
  it("parses daemon JSON over a Unix socket", async () => {
    await withServer(
      (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, daemon: null }));
      },
      async (socketPath) => {
        await expect(createCovenClient(socketPath).health()).resolves.toEqual({
          ok: true,
          daemon: null,
        });
      },
    );
  });

  it("validates a real socket inside the configured socket root", async () => {
    await withServer(
      (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, daemon: null }));
      },
      async (socketPath) => {
        await expect(
          createCovenClient(socketPath, { socketRoot: tmpDir }).health(),
        ).resolves.toEqual({
          ok: true,
          daemon: null,
        });
      },
    );
  });

  it("sends the event cursor when listing events", async () => {
    await withServer(
      (req, res) => {
        expect(req.url).toBe("/events?sessionId=session-1&afterEventId=event-1");
        res.setHeader("Content-Type", "application/json");
        res.end("[]");
      },
      async (socketPath) => {
        await expect(
          createCovenClient(socketPath).listEvents("session-1", { afterEventId: "event-1" }),
        ).resolves.toEqual([]);
      },
    );
  });

  it("wraps invalid daemon JSON in a typed API error", async () => {
    await withServer(
      (_req, res) => {
        res.end("{not json");
      },
      async (socketPath) => {
        await expect(createCovenClient(socketPath).health()).rejects.toBeInstanceOf(CovenApiError);
      },
    );
  });

  it("rejects daemon responses above the response size limit", async () => {
    await withServer(
      (_req, res) => {
        res.end("x".repeat(1_000_001));
      },
      async (socketPath) => {
        await expect(createCovenClient(socketPath).health()).rejects.toThrow(/size limit/);
      },
    );
  });

  it("rejects request bodies above the request size limit", async () => {
    await withServer(
      (_req, res) => {
        res.end("{}");
      },
      async (socketPath) => {
        await expect(
          createCovenClient(socketPath).launchSession({
            projectRoot: "/repo",
            cwd: "/repo",
            harness: "codex",
            prompt: "x".repeat(1_000_001),
            title: "Large prompt",
          }),
        ).rejects.toThrow(/request exceeded size limit/);
      },
    );
  });

  it("revalidates socket paths before connecting", async () => {
    const covenHome = path.join(tmpDir, ".coven");
    await fs.mkdir(covenHome);
    await fs.chmod(covenHome, 0o700);
    const socketPath = path.join(covenHome, "coven.sock");
    await fs.symlink("/var/run/docker.sock", socketPath);

    await expect(createCovenClient(socketPath, { socketRoot: covenHome }).health()).rejects.toThrow(
      /must not be a symlink/,
    );
  });

  it("rejects a socket root that resolves through a symlink", async () => {
    const realHome = path.join(tmpDir, "real-coven");
    const symlinkHome = path.join(tmpDir, "symlink-coven");
    await fs.mkdir(realHome);
    await fs.chmod(realHome, 0o700);
    await fs.symlink(realHome, symlinkHome);

    await expect(
      createCovenClient(path.join(symlinkHome, "coven.sock"), { socketRoot: symlinkHome }).health(),
    ).rejects.toThrow(/covenHome must not be a symlink/);
  });

  it("rejects missing socket roots with a validation error", async () => {
    const covenHome = path.join(tmpDir, "missing-coven");

    await expect(
      createCovenClient(path.join(covenHome, "coven.sock"), { socketRoot: covenHome }).health(),
    ).rejects.toThrow(/covenHome must exist/);
  });

  it("rejects a group or world writable socket root", async () => {
    if (process.platform === "win32") {
      return;
    }
    const covenHome = path.join(tmpDir, ".coven");
    await fs.mkdir(covenHome);
    await fs.chmod(covenHome, 0o777);

    await expect(
      createCovenClient(path.join(covenHome, "coven.sock"), { socketRoot: covenHome }).health(),
    ).rejects.toThrow(/covenHome must not be group or world writable/);
  });

  it("rejects socket paths that are not Unix sockets", async () => {
    const covenHome = path.join(tmpDir, ".coven");
    await fs.mkdir(covenHome);
    await fs.chmod(covenHome, 0o700);
    const socketPath = path.join(covenHome, "coven.sock");
    await fs.writeFile(socketPath, "");

    await expect(createCovenClient(socketPath, { socketRoot: covenHome }).health()).rejects.toThrow(
      /must be a Unix socket/,
    );
  });
});
