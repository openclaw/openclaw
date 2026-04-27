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
});
