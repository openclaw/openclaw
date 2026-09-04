import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMcpSession } from "./chrome-mcp-connect.js";
import { CHROME_MCP_STDERR_MAX_BYTES } from "./chrome-mcp-contracts.js";
import { closeTrackedChromeMcpSession } from "./chrome-mcp-process.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ child: () => ({ warn }) }),
}));

type ChildEvent = { event: string; pid: number; ppid: number; at: number };

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function runStdioFixture(mode: "pressure" | "initialize-error") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-stdio-"));
  const script = path.join(root, "peer.mjs");
  const eventsPath = path.join(root, "events.jsonl");
  const secret = "fixture-credential";
  const diagnosticUrl = new URL("https://example.invalid/");
  diagnosticUrl.username = "fixture-user";
  diagnosticUrl.password = "fixture-password";
  diagnosticUrl.searchParams.set("token", secret);
  const diagnostic = `startup-tail-é ${diagnosticUrl.href} ${path.join(os.homedir(), "fixture-profile")}`;
  await fs.writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ event, pid: process.pid, ppid: process.ppid, at: Date.now() }) + "\\n");
record("started");
const stderr = "discard-start\\n" + "é".repeat(${mode === "pressure" ? 512 * 1024 : 8192}) + ${JSON.stringify(`\n${diagnostic}\n`)};
record("stderr-queued");
await new Promise((resolve, reject) => process.stderr.write(stderr, (error) => error ? reject(error) : resolve()));
record("stderr-drained");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  record(request.method);
  if (!Object.hasOwn(request, "id")) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio-fixture", version: "1.0.0" } }
    : { tools: [{ name: "list_pages", inputSchema: { type: "object" } }] };
  const response = ${JSON.stringify(mode)} === "initialize-error"
    ? { error: { code: -32000, message: "fixture initialization failed" } }
    : { result };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\\n");
});
input.on("close", () => process.exit(0));
`,
  );
  const cacheKey = JSON.stringify([root]);
  const creation = createChromeMcpSession(cacheKey, "stdio-fixture", {
    command: process.execPath,
    args: [script],
  });
  const session = await creation.promise;
  const pid = session.transport.pid;
  const close = vi.spyOn(session.client, "close");
  const closed = new Promise<void>((resolve) => {
    const onclose = session.client.onclose;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes callbacks, not EventTarget.
    session.client.onclose = () => {
      onclose?.();
      resolve();
    };
  });
  const stderrEnded = once(session.transport.stderr!, "end");
  let readinessError: unknown;
  try {
    await session.ready.catch((error: unknown) => {
      readinessError = error;
    });
  } finally {
    await closeTrackedChromeMcpSession(cacheKey, session);
    await creation.cleanup;
    // A failed startup can leave unread stderr delaying close after the child exits.
    session.transport.stderr?.on("data", () => {});
    await stderrEnded;
    // Failed initialization starts SDK close asynchronously; stderr EOF is not child exit.
    await closed;
  }
  try {
    const events = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ChildEvent);
    expect(pid).toBeGreaterThan(0);
    expect(events.every((event) => event.pid === pid && event.ppid === process.pid)).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(session.transport.pid).toBeNull();
    expect(session.processCleanup?.status).toBe("closed");
    expect(() => process.kill(pid!, 0)).toThrow();
    return { readinessError, events, secret };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("Chrome MCP real stdio startup", () => {
  it("drains pipe-pressure stderr before initialize and closes its exact child", async () => {
    const { readinessError, events } = await runStdioFixture("pressure");
    expect(readinessError, JSON.stringify(events)).toBeUndefined();
    expect(events.map(({ event }) => event)).toEqual([
      "started",
      "stderr-queued",
      "stderr-drained",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(warn).not.toHaveBeenCalled();
  }, 45_000);

  it("retains bounded redacted stderr when initialization fails", async () => {
    const { readinessError, events, secret } = await runStdioFixture("initialize-error");
    expect(readinessError).toBeInstanceOf(Error);
    expect((readinessError as Error).message).toContain("fixture initialization failed");
    expect(events.map(({ event }) => event)).toEqual([
      "started",
      "stderr-queued",
      "stderr-drained",
      "initialize",
    ]);
    expect(warn).toHaveBeenCalledOnce();
    const diagnostic = String(warn.mock.calls[0]?.[0]).split("Subprocess stderr:\n")[1]!;
    expect(diagnostic).toContain("startup-tail-é");
    expect(diagnostic).toContain("~/fixture-profile");
    expect(diagnostic).not.toContain("discard-start");
    expect(diagnostic).not.toContain("�");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("fixture-user");
    expect(diagnostic).not.toContain("fixture-password");
    expect(diagnostic).not.toContain(os.homedir());
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(CHROME_MCP_STDERR_MAX_BYTES);
  }, 45_000);
});
