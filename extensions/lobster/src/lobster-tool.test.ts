import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ClawdbotPluginApi, ClawdbotPluginToolContext } from "../../../src/plugins/types.js";
import { createLobsterTool } from "./lobster-tool.js";

async function writeFakeLobster(params: {
  payload: unknown;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-lobster-plugin-"));
  const binPath = path.join(dir, "lobster");

  const file = `#!/usr/bin/env node\n` +
    `process.stdout.write(JSON.stringify(${JSON.stringify(params.payload)}));\n`;

  await fs.writeFile(binPath, file, { encoding: "utf8", mode: 0o755 });
  return { dir, binPath };
}

function fakeApi(): ClawdbotPluginApi {
  return {
    id: "lobster",
    name: "lobster",
    source: "test",
    config: {} as any,
    runtime: { version: "test" } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHttpHandler() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    resolvePath: (p) => p,
  };
}

function fakeCtx(overrides: Partial<ClawdbotPluginToolContext> = {}): ClawdbotPluginToolContext {
  return {
    config: {} as any,
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "main",
    messageChannel: undefined,
    agentAccountId: undefined,
    sandboxed: false,
    ...overrides,
  };
}

describe("lobster plugin tool", () => {
  it("runs lobster and returns parsed envelope in details", async () => {
    const fake = await writeFakeLobster({
      payload: { ok: true, status: "ok", output: [{ hello: "world" }], requiresApproval: null },
    });

    const tool = createLobsterTool(fakeApi());
    const res = await tool.execute("call1", {
      action: "run",
      pipeline: "noop",
      lobsterPath: fake.binPath,
      timeoutMs: 1000,
    });

    expect(res.details).toMatchObject({ ok: true, status: "ok" });
  });

  it("requires absolute lobsterPath when provided", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call2", {
        action: "run",
        pipeline: "noop",
        lobsterPath: "./lobster",
      }),
    ).rejects.toThrow(/absolute path/);
  });

  it("rejects invalid JSON from lobster", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-lobster-plugin-bad-"));
    const binPath = path.join(dir, "lobster");
    await fs.writeFile(binPath, `#!/usr/bin/env node\nprocess.stdout.write('nope');\n`, {
      encoding: "utf8",
      mode: 0o755,
    });

    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call3", {
        action: "run",
        pipeline: "noop",
        lobsterPath: binPath,
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("can be gated off in sandboxed contexts", async () => {
    const api = fakeApi();
    const factoryTool = (ctx: ClawdbotPluginToolContext) => {
      if (ctx.sandboxed) return null;
      return createLobsterTool(api);
    };

    expect(factoryTool(fakeCtx({ sandboxed: true }))).toBeNull();
    expect(factoryTool(fakeCtx({ sandboxed: false }))?.name).toBe("lobster");
  });
});
