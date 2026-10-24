import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCodexSessionCli } from "./session-cli.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return {
    ...actual,
    callGatewayFromCli: gatewayRuntime.callGatewayFromCli,
  };
});

const catalog = {
  hosts: [
    {
      hostId: "gateway:local",
      label: "MacBook Pro",
      kind: "gateway",
      connected: true,
      sessions: [
        {
          threadId: "00000000-0000-4000-8000-000000000002",
          name: "Build Codex fleet sessions",
          cwd: "/Users/test/Projects/openclaw",
          status: "idle",
          recencyAt: 1_788_805_800,
          source: "vscode",
          modelProvider: "openai",
          gitBranch: "codex/codex-session-fleet",
        },
      ],
      nextCursor: "gateway-next",
    },
    {
      hostId: "node:devbox",
      label: "Dev Box",
      kind: "node",
      connected: false,
      nodeId: "devbox",
      sessions: [],
      error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
    },
  ],
};

function gatewayCatalog(hosts: unknown[]) {
  return { catalogs: [{ id: "codex", hosts }] };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerCodexSessionCli(program);
  return program;
}

async function runCli(
  args: string[],
  flags: Record<string, string | boolean> = {},
): Promise<string> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const options = Object.entries(flags).flatMap(([name, value]) =>
      value === true ? [`--${name}`] : [`--${name}`, String(value)],
    );
    await createProgram().parseAsync(["codex", ...args, ...options], { from: "user" });
    return chunks.join("");
  } finally {
    write.mockRestore();
  }
}

function expectGateway(
  action: string,
  params: Record<string, unknown>,
  options: Record<string, string | boolean> = { timeout: "75000", json: false },
) {
  expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
    `sessions.catalog.${action}`,
    options,
    { catalogId: "codex", ...params },
    { mode: "cli", scopes: ["operator.write"] },
  );
}

describe("registerCodexSessionCli", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.callGatewayFromCli.mockResolvedValue(gatewayCatalog(catalog.hosts));
  });

  describe("sessions", () => {
    it("maps non-archived filters and a host cursor to the catalog Gateway method", async () => {
      const output = await runCli(["sessions"], {
        agent: "JarVis",
        search: "  openclaw  ",
        host: "node:devbox",
        limit: "25",
        cursor: "node-next",
        url: "ws://gateway.test",
        token: "secret",
        timeout: "1234",
        json: true,
      });
      expectGateway(
        "list",
        {
          agentId: "jarvis",
          search: "openclaw",
          limitPerHost: 25,
          hostIds: ["node:devbox"],
          cursors: { "node:devbox": "node-next" },
        },
        { url: "ws://gateway.test", token: "secret", timeout: "1234", json: true },
      );
      expect(JSON.parse(output)).toEqual({ hosts: [catalog.hosts[1]] });
    });

    it("renders connected sessions, metadata, pagination, and offline host errors", async () => {
      const output = await runCli(["sessions"]);
      expectGateway("list", {});
      expect(output).toContain("MacBook Pro (gateway · gateway:local) — connected — 1 session");
      expect(output).toContain("00000000-0000-4000-8000-000000000002");
      expect(output).toContain("Build Codex fleet sessions");
      expect(output).toContain("/Users/test/Projects/openclaw");
      expect(output).toContain("branch codex/codex-session-fleet");
      expect(output).toContain("source vscode");
      expect(output).toContain("provider openai");
      expect(output).toContain(
        "repeat the same filters with --host 'gateway:local' --cursor 'gateway-next'",
      );
      expect(output).toContain("Dev Box (node · node:devbox · devbox) — offline — 0 sessions");
      expect(output).toContain("Error [NODE_OFFLINE]: Paired node is offline");
    });

    it("neutralizes terminal controls in human-readable host and session metadata", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce(
        gatewayCatalog([
          {
            hostId: "gateway:local\u001b",
            label: "Mac\u001b[31m\nBook",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "thread\u001b[2J",
                name: "Fleet\u0007\nSession",
                cwd: "/tmp/work\u001b]0;owned\u0007",
                status: "idle\u001b",
                gitBranch: "main\u0000branch",
              },
            ],
            error: { code: "WARN\u001b", message: "first\nsecond\u0007" },
            nextCursor: "next\u001b[2J",
          },
        ]),
      );

      const output = await runCli(["sessions"]);
      for (const control of ["\u001b", "\u0007", "\u0000"]) {
        expect(output).not.toContain(control);
      }
      expect(output).toContain("Fleet\\nSession");
      expect(output).toContain("mainbranch");
      expect(output).toContain("Error [WARN]: first\\nsecond");
    });

    it("reports empty catalog and unmatched host results", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValue(gatewayCatalog([]));

      const emptyOutput = await runCli(["sessions"]);
      const hostOutput = await runCli(["sessions"], { host: "node:missing" });

      expect(emptyOutput).toBe("No Codex session hosts found.\n");
      expect(hostOutput).toBe('No Codex session host matched "node:missing".\n');
    });
  });

  describe("continue", () => {
    it("continues a Gateway-local thread and sanitizes the human-readable session key", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({
        sessionKey: "harness:codex:supervision:branch\u001b[2J",
      });

      const output = await runCli(["continue", "thread-1"], {
        agent: "JarVis",
        host: "gateway:local:source-a",
        url: "ws://gateway.test",
        token: "secret",
        timeout: "4321",
      });
      expectGateway(
        "continue",
        {
          agentId: "jarvis",
          hostId: "gateway:local:source-a",
          threadId: "thread-1",
        },
        { url: "ws://gateway.test", token: "secret", timeout: "4321", json: false },
      );
      expect(output).toBe("OpenClaw session: harness:codex:supervision:branch\n");
      expect(output).not.toContain("\u001b");
    });

    it("prints existing session results as JSON", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({
        sessionKey: "harness:codex:supervision:existing",
        ignored: true,
      });

      const output = await runCli(["continue", "thread-2"], { json: true });

      expect(JSON.parse(output)).toEqual({
        sessionKey: "harness:codex:supervision:existing",
      });
    });
  });

  describe("archive", () => {
    it("renders a successful archive in human-readable output", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ ok: true });

      const output = await runCli(["archive", "thread-2"], { "confirm-no-other-runner": true });

      expect(output).toBe("Archived Codex thread thread-2.\n");
    });
  });

  it.each([
    [["sessions", "--archived"], "unknown option '--archived'"],
    [["sessions", "--cursor", "next"], "--cursor requires --host"],
    [["sessions", "--limit", "1.5"], "--limit must be an integer between 1 and 100"],
    [["sessions", "--limit", "101"], "--limit must be an integer between 1 and 100"],
    [["continue", "   "], "Codex thread id must not be empty"],
    [["archive", "thread-1"], "--confirm-no-other-runner is required"],
  ] satisfies [string[], string][])("rejects %j before Gateway access", async (args, message) => {
    await expect(runCli(args)).rejects.toThrow(message);
    expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ["sessions"],
      result: { catalogs: null },
      message: "Codex session catalog returned an invalid result",
    },
    { args: ["sessions"], result: { catalogs: [] }, message: "catalog is unavailable" },
    { args: ["continue", "thread-1"], result: { sessionKey: " " }, message: "invalid session key" },
    {
      args: ["archive", "thread-1", "--confirm-no-other-runner"],
      result: { ok: false },
      message: "Codex session archive returned an invalid result",
    },
  ])("rejects malformed Gateway response: $message", async ({ args, result, message }) => {
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce(result);
    await expect(runCli(args)).rejects.toThrow(message);
  });
});
