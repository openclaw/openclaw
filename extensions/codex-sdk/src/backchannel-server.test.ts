import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const serverPath = path.resolve("extensions/codex-sdk/src/backchannel-server.mjs");

async function createTempStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-backchannel-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) {
      child.kill();
    }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("codex-sdk backchannel MCP server", () => {
  it("lists tools and writes proposals to local state when the gateway is unavailable", async () => {
    const stateDir = await createTempStateDir();
    const child = spawn(process.execPath, [serverPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_CODEX_BACKCHANNEL_STATE_DIR: stateDir,
        OPENCLAW_CODEX_BACKCHANNEL_URL: "ws://127.0.0.1:9",
        OPENCLAW_CODEX_BACKCHANNEL_REQUEST_TIMEOUT_MS: "100",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const responses = new Map<number, unknown>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const parsed = JSON.parse(line) as { id?: number };
      if (typeof parsed.id === "number") {
        responses.set(parsed.id, parsed);
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openclaw-test", version: "1.0.0" },
      },
    });
    const initialized = await waitForResponse(responses, 1, () => stderr);
    expect(initialized).toEqual(expect.objectContaining({ result: expect.any(Object) }));
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = (await waitForResponse(responses, 2, () => stderr)) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["openclaw_status", "openclaw_gateway_request", "openclaw_proposal"]),
    );

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "openclaw_proposal",
        arguments: {
          title: "Backchannel proposal",
          summary: "Created by Codex through MCP.",
          actions: ["review"],
        },
      },
    });
    const called = (await waitForResponse(responses, 3, () => stderr)) as {
      result?: { content?: Array<{ type: string; text: string }> };
    };
    const payload = JSON.parse(called.result?.content?.[0]?.text ?? "{}") as {
      title?: string;
      status?: string;
    };
    expect(payload).toMatchObject({ title: "Backchannel proposal", status: "new" });

    const inbox = await fs.readFile(
      path.join(stateDir, "codex-sdk", "proposal-inbox.jsonl"),
      "utf8",
    );
    expect(inbox).toContain("Backchannel proposal");
  });
});

async function waitForResponse(
  responses: Map<number, unknown>,
  id: number,
  stderr: () => string,
): Promise<unknown> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (responses.has(id)) {
      return responses.get(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for MCP response ${id}.\n${stderr()}`);
}
