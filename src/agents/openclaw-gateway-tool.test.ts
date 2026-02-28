import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

async function defaultGatewayToolMock(method: string) {
  if (method === "config.get") {
    return { hash: "hash-1" };
  }
  return { ok: true };
}

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(defaultGatewayToolMock),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

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

function estimateTokenUsageFromText(text: string): number {
  const message = {
    role: "toolResult",
    toolCallId: "call_benchmark",
    toolName: "gateway",
    isError: false,
    content: [{ type: "text", text }],
    timestamp: 0,
  } as const satisfies Parameters<typeof estimateTokens>[0];
  return estimateTokens(message);
}

function readToolResultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const block = result.content?.find(
    (entry): entry is { type: string; text: string } =>
      entry.type === "text" && typeof entry.text === "string",
  );
  expect(block).toBeDefined();
  return block?.text ?? "";
}

function buildLargeConfigFixture(): Record<string, unknown> {
  const groups = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `team-${index}`,
      {
        requireMention: index % 2 === 0,
        allowlist: [`ops-${index}`, `alerts-${index}`, `releases-${index}`],
      },
    ]),
  );
  return {
    agents: {
      defaults: {
        workspace: "~/openclaw",
        model: "gpt-5",
      },
    },
    channels: {
      telegram: {
        groups,
      },
      discord: {
        guilds: groups,
      },
    },
    tools: {
      browser: {
        enabled: true,
      },
      web_search: {
        provider: "brave",
      },
    },
  };
}

describe("gateway tool", () => {
  beforeEach(async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    vi.mocked(callGatewayTool).mockReset();
    vi.mocked(callGatewayTool).mockImplementation(defaultGatewayToolMock);
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

    const raw = '{\n  agents: { defaults: { workspace: "~/openclaw" } }\n}\n';
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

  it("returns minimal-diff output for config.patch by default", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);
    const raw = '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }';

    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.patch") {
        return {
          ok: true,
          path: "~/.openclaw/openclaw.json",
          changedPaths: ["channels.telegram.groups.*.requireMention"],
          config: { channels: { telegram: { groups: { "*": { requireMention: false } } } } },
        };
      }
      return { ok: true };
    });

    const result = await tool.execute("call5", {
      action: "config.patch",
      raw,
    });
    const details = result.details as {
      ok?: boolean;
      result?: Record<string, unknown>;
    };

    expect(details.ok).toBe(true);
    expect(details.result).toMatchObject({
      ok: true,
      changedPaths: ["channels.telegram.groups.*.requireMention"],
      outputMode: "minimal-diff",
      fetchFullConfigAction: "config.fetch-full",
    });
    expect(details.result?.config).toBeUndefined();
  });

  it("derives minimal-diff paths from raw patch when changedPaths is missing", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);
    const raw = '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }';

    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.patch") {
        return {
          ok: true,
          path: "~/.openclaw/openclaw.json",
          config: { channels: { telegram: { groups: { "*": { requireMention: false } } } } },
        };
      }
      return { ok: true };
    });

    const result = await tool.execute("call5b", {
      action: "config.patch",
      raw,
    });
    const details = result.details as {
      ok?: boolean;
      result?: Record<string, unknown>;
    };
    const changedPaths = details.result?.changedPaths;

    expect(details.ok).toBe(true);
    expect(Array.isArray(changedPaths)).toBe(true);
    expect(changedPaths).toContain("channels.telegram.groups.*.requireMention");
    expect(details.result?.changedPathsSource).toBe("requested-patch");
  });

  it("returns full config.patch output when outputMode=full", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);
    const raw = '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }';

    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.patch") {
        return {
          ok: true,
          path: "~/.openclaw/openclaw.json",
          changedPaths: ["channels.telegram.groups.*.requireMention"],
          config: { channels: { telegram: { groups: { "*": { requireMention: false } } } } },
        };
      }
      return { ok: true };
    });

    const result = await tool.execute("call6", {
      action: "config.patch",
      raw,
      outputMode: "full",
    });
    const details = result.details as {
      ok?: boolean;
      result?: Record<string, unknown>;
    };

    expect(details.ok).toBe(true);
    expect(details.result?.config).toBeDefined();
    expect(details.result?.outputMode).toBeUndefined();
  });

  it("rejects unsupported config.patch outputMode values", async () => {
    const tool = requireGatewayTool("agent:main:whatsapp:dm:+15555550123");
    const raw = '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }';

    await expect(
      tool.execute("call6b", {
        action: "config.patch",
        raw,
        outputMode: "diff-only",
      }),
    ).rejects.toThrow(/Invalid outputMode/i);
  });

  it("supports explicit full snapshot fetch via config.fetch-full", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = requireGatewayTool();
    const fullSnapshot = {
      hash: "hash-2",
      config: buildLargeConfigFixture(),
    };
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return fullSnapshot;
      }
      return { ok: true };
    });

    const result = await tool.execute("call7", {
      action: "config.fetch-full",
    });
    const details = result.details as {
      ok?: boolean;
      result?: Record<string, unknown>;
    };

    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(details).toMatchObject({
      ok: true,
      result: fullSnapshot,
    });
  });

  it("benchmarks lower token usage for minimal-diff vs full config.patch output", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tool = requireGatewayTool("agent:main:whatsapp:dm:+15555550123");
    const raw = '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }';
    const fullConfig = buildLargeConfigFixture();
    const patchResult = {
      ok: true,
      path: "~/.openclaw/openclaw.json",
      changedPaths: ["channels.telegram.groups.*.requireMention"],
      config: fullConfig,
      restart: { ok: true, pid: 1234, signal: "SIGUSR1", delayMs: 2000 },
      sentinel: { path: "/tmp/restart-sentinel.json" },
    };

    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      if (method === "config.patch") {
        return patchResult;
      }
      return { ok: true };
    });

    const fullOutput = await tool.execute("call8", {
      action: "config.patch",
      raw,
      outputMode: "full",
    });
    const minimalOutput = await tool.execute("call9", {
      action: "config.patch",
      raw,
    });

    const fullTokens = estimateTokenUsageFromText(readToolResultText(fullOutput));
    const minimalTokens = estimateTokenUsageFromText(readToolResultText(minimalOutput));

    expect(fullTokens).toBeGreaterThan(0);
    expect(minimalTokens).toBeLessThan(fullTokens);
    expect(minimalTokens / fullTokens).toBeLessThan(0.5);
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
});
