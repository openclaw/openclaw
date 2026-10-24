import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_PROTOCOL_FIXTURE } from "./cli-runtime.protocol.test-support.js";
import {
  collectClaudeCli,
  createCliTestHarness,
  resultDetail,
} from "./cli-runtime.test-support.js";

const harness = createCliTestHarness("openclaw-claude-mcp-startup-");
afterEach(() => harness.cleanup());

const connected = [
  { name: "optional-server", status: "failed" },
  { name: "openclaw", status: "connected" },
];

async function contextFor(servers: Array<{ name: string; status: string }>) {
  return harness.context(
    CLAUDE_PROTOCOL_FIXTURE,
    { liveSession: harness.liveSession() },
    { CLAUDE_FIXTURE_SCENARIO: "normal", CLAUDE_FIXTURE_MCP_SERVERS: JSON.stringify(servers) },
  );
}

describe("Claude CLI MCP startup", () => {
  it.each(["failed", "pending"])(
    "retires a process with %s OpenClaw MCP startup before starting a fresh turn",
    async (status) => {
      const context = await contextFor([
        { name: "optional-server", status: "connected" },
        { name: "openclaw", status },
      ]);
      await expect(collectClaudeCli(context)).rejects.toThrow(
        `Claude Code started without the OpenClaw MCP server (status ${status}). The CLI process was retired; retry the request to start a fresh process.`,
      );
      const failedPid = Number(await readFile(path.join(context.cwd, "fixture.pid"), "utf8"));
      expect(context.liveSession?.current()).toBeUndefined();
      expect(() => process.kill(failedPid, 0)).toThrow();

      const next = resultDetail(
        await collectClaudeCli({
          ...context,
          useResume: true,
          env: { ...context.env, CLAUDE_FIXTURE_MCP_SERVERS: JSON.stringify(connected) },
        }),
      );
      expect(next.turn).toBe(1);
      expect(next.pid).not.toBe(failedPid);
      expect(context.liveSession?.current()?.isIdle()).toBe(true);
    },
  );

  it.each([
    { name: "connected OpenClaw MCP", servers: connected },
    { name: "no OpenClaw MCP entry", servers: [{ name: "optional-server", status: "failed" }] },
  ])("keeps a healthy session reusable with $name", async ({ servers }) => {
    const context = await contextFor(servers);
    const first = resultDetail(await collectClaudeCli(context));
    const handle = context.liveSession?.current();
    const second = resultDetail(await collectClaudeCli({ ...context, useResume: true }));
    expect(second).toMatchObject({ pid: first.pid, turn: 2 });
    expect(context.liveSession?.current()).toBe(handle);
    expect(handle?.isIdle()).toBe(true);
  });
});
