import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import "./test-helpers/fast-core-tools.js";

function createGatewayToolModuleMocks() {
  return {
    callGatewayTool: vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.schema.lookup") {
        return {
          path: "gateway.auth",
          schema: {
            type: "object",
          },
          hint: { label: "Gateway Auth" },
          hintPath: "gateway.auth",
          children: [
            {
              key: "token",
              path: "gateway.auth.token",
              type: "string",
              required: true,
              hasChildren: false,
              hint: { label: "Token", sensitive: true },
              hintPath: "gateway.auth.token",
            },
          ],
        };
      }
      return { ok: true };
    }),
    readGatewayCallOptions: vi.fn(() => ({})),
  };
}

vi.mock("./tools/gateway.js", () => createGatewayToolModuleMocks());

let createOpenClawTools: typeof import("./openclaw-tools.js").createOpenClawTools;

async function loadFreshOpenClawToolsModuleForTest() {
  vi.resetModules();
  vi.doMock("./tools/gateway.js", () => createGatewayToolModuleMocks());
  ({ createOpenClawTools } = await import("./openclaw-tools.js"));
}

function requireGatewayTool(agentSessionKey?: string) {
  const tool = createOpenClawTools({
    ...(agentSessionKey ? { agentSessionKey } : {}),
    config: { commands: { restart: true } },
  }).find((candidate) => candidate.name === "gateway");
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error("missing gateway tool");
  }
  return tool;
}

function expectConfigMutationCall(params: {
  callGatewayTool: {
    mock: {
      calls: Array<readonly unknown[]>;
    };
  };
  action: "config.apply" | "config.patch";
  raw: string;
  sessionKey: string;
}) {
  expect(params.callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
  expect(params.callGatewayTool).toHaveBeenCalledWith(
    params.action,
    expect.any(Object),
    expect.objectContaining({
      raw: params.raw.trim(),
      baseHash: "hash-1",
      sessionKey: params.sessionKey,
    }),
  );
}

describe("gateway tool", () => {
  beforeEach(async () => {
    await loadFreshOpenClawToolsModuleForTest();
  });

  it("marks gateway as owner-only", async () => {
    const tool = requireGatewayTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("schedules SIGUSR1 restart", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));

    try {
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "isolated" },
        async () => {
          const tool = requireGatewayTool();

          const result = await tool.execute("call1", {
            action: "restart",
            delayMs: 0,
          });
          expect(result.details).toMatchObject({
            ok: true,
            pid: process.pid,
            signal: "SIGUSR1",
            delayMs: 0,
          });

          const sentinelPath = path.join(stateDir, "restart-sentinel.json");
          const raw = await fs.readFile(sentinelPath, "utf-8");
          const parsed = JSON.parse(raw) as {
            payload?: { kind?: string; doctorHint?: string | null };
          };
          expect(parsed.payload?.kind).toBe("restart");
          expect(parsed.payload?.doctorHint).toBe(
            "Run: openclaw --profile isolated doctor --non-interactive",
          );

          expect(kill).not.toHaveBeenCalled();
          await vi.runAllTimersAsync();
          expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
        },
      );
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes config.apply through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw =
      '{\n  agents: { defaults: { workspace: "~/openclaw" } },\n  tools: { exec: { ask: "on-miss", security: "allowlist" } }\n}\n';
    await tool.execute("call2", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("passes config.patch through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    await tool.execute("call4", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey,
    });
  });

  it("rejects config.patch when it changes exec approval settings", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { ask: "off" } } }',
      }),
    ).rejects.toThrow("gateway config.patch cannot change protected config paths: tools.exec.ask");
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes exec security settings", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when protected exec settings are omitted", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-missing-protected", {
        action: "config.apply",
        raw: '{ agents: { defaults: { workspace: "~/openclaw" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.ask, tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("passes update.run through gateway call", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey,
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("returns a path-scoped schema lookup result", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = requireGatewayTool();

    const result = await tool.execute("call5", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.schema.lookup", expect.any(Object), {
      path: "gateway.auth",
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        path: "gateway.auth",
        hintPath: "gateway.auth",
        children: [
          expect.objectContaining({
            key: "token",
            path: "gateway.auth.token",
            required: true,
            hintPath: "gateway.auth.token",
          }),
        ],
      },
    });
    const schema = (result.details as { result?: { schema?: { properties?: unknown } } }).result
      ?.schema;
    expect(schema?.properties).toBeUndefined();
  });
});
