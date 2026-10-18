import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn(async () => undefined));
const listToolsMock = vi.hoisted(() => vi.fn(async () => ({ tools: [] })));
const callToolMock = vi.hoisted(() => vi.fn(async () => ({ content: [] })));
const closeMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/node"));
const stderrOnMock = vi.hoisted(() => vi.fn());
const stdioTransportMock = vi.hoisted(() =>
  vi.fn(
    class StdioClientTransport {
      stderr = { on: stderrOnMock };
    },
  ),
);

vi.mock("@modelcontextprotocol/client", () => ({
  Client: vi.fn(
    class Client {
      connect = connectMock;
      request = listToolsMock;
      callTool = callToolMock;
      close = closeMock;
    },
  ),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: stdioTransportMock,
}));

vi.mock("./node-exec.js", () => ({
  resolveQaNodeExecPath: resolveQaNodeExecPathMock,
}));

import {
  callPluginToolsMcp,
  findSkill,
  handleQaAction,
  writeWorkspaceSkill,
} from "./suite-runtime-agent-tools.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

function callMcp(toolName = "plugin.echo", args = {}, root = "/repo/openclaw") {
  return callPluginToolsMcp({
    env: {
      gateway: { tempRoot: "/tmp/openclaw-qa-runtime", runtimeEnv: { PATH: "/usr/bin" } },
      repoRoot: root,
    } as never,
    toolName,
    args,
  });
}

function emitStderr(text: string) {
  const listener = stderrOnMock.mock.calls[0]?.[1] as ((chunk: unknown) => void) | undefined;
  listener?.(Buffer.from(text));
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  listToolsMock.mockReset();
  callToolMock.mockReset();
});

it("finds a skill by exact name", () => {
  expect(findSkill([{ name: "alpha" }, { name: "beta" }], "beta")).toEqual({ name: "beta" });
  expect(findSkill([{ name: "alpha" }], "beta")).toBeUndefined();
});

it("writes a workspace skill under the gateway workspace", async () => {
  const workspaceDir = await makeTempDir("qa-workspace-");

  const skillPath = await writeWorkspaceSkill({
    env: { gateway: { workspaceDir } } as never,
    name: "my-skill",
    body: "hello world",
  });

  await expect(fs.readFile(skillPath, "utf8")).resolves.toBe("hello world\n");
  expect(skillPath).toBe(path.join(workspaceDir, "skills", "my-skill", "SKILL.md"));
});

it("rejects workspace skill names that escape the skills directory", async () => {
  const workspaceDir = await makeTempDir("qa-workspace-");

  for (const name of ["", " spaced", "spaced ", ".", "..", "../escape", "..\\escape", "a/b"]) {
    await expect(
      writeWorkspaceSkill({
        env: { gateway: { workspaceDir } } as never,
        name,
        body: "escape",
      }),
    ).rejects.toThrow(`invalid QA workspace skill name: ${JSON.stringify(name)}`);
  }

  await expect(fs.readdir(path.join(workspaceDir, "skills"))).rejects.toThrow();
});

it("routes generic transport actions through the payload extractor", async () => {
  const handleAction = vi.fn(async () => ({
    content: [{ type: "text", text: "done" }],
  }));

  const env = { cfg: {}, transport: { handleAction } } as never;
  await expect(handleQaAction({ env, action: "react", args: {} })).resolves.toEqual("done");
});

it("prefers the built plugin-tools MCP entry", async () => {
  const builtRepoRoot = await makeTempDir("qa-built-repo-");
  const distEntry = path.join(builtRepoRoot, "dist", "mcp", "plugin-tools-serve.js");
  await fs.mkdir(path.dirname(distEntry), { recursive: true });
  await fs.writeFile(distEntry, "// built MCP entry\n", "utf8");
  listToolsMock.mockResolvedValueOnce({
    tools: [{ name: "plugin.echo" }] as never[],
  });

  await callMcp("plugin.echo", {}, builtRepoRoot);

  expect(stdioTransportMock).toHaveBeenCalledWith(
    expect.objectContaining({
      command: "/usr/bin/node",
      args: [distEntry],
      cwd: builtRepoRoot,
    }),
  );
  expect(connectMock).toHaveBeenCalledWith(expect.anything(), { timeout: 180_000 });
  expect(listToolsMock).toHaveBeenCalledWith(
    { method: "tools/list", params: {} },
    { timeout: 180_000 },
  );
  expect(callToolMock).toHaveBeenCalledWith(
    { name: "plugin.echo", arguments: {} },
    {
      timeout: 180_000,
      toolDefinition: { name: "plugin.echo" },
    },
  );
});

it("reports available plugin-tools MCP names when the requested tool is missing", async () => {
  listToolsMock.mockResolvedValueOnce({
    tools: [{ name: "plugin.beta" }, { name: "plugin.alpha" }] as never[],
  });

  await expect(callMcp("plugin.missing")).rejects.toThrow(
    "MCP tool missing: plugin.missing; available tools: plugin.alpha, plugin.beta",
  );

  expect(callToolMock).not.toHaveBeenCalled();
  expect(closeMock).toHaveBeenCalled();
});

it.each([
  [
    "call",
    `old stderr${"x".repeat(12_000)}\nrecent MCP stderr tail`,
    "tool call failed",
    ["MCP stderr truncated to last", "recent MCP stderr tail"],
  ],
  [
    "startup",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@openclaw/example'\n",
    "MCP error -32000: Connection closed",
    ["Cannot find package '@openclaw/example'"],
  ],
] as const)(
  "preserves bounded MCP stderr on %s failures",
  async (phase, stderr, error, expected) => {
    listToolsMock.mockResolvedValueOnce({ tools: [{ name: "plugin.echo" }] as never[] });
    const fail = async () => {
      emitStderr(stderr);
      throw new Error(error);
    };
    (phase === "call" ? callToolMock : connectMock).mockImplementationOnce(fail);
    const failure = await callMcp("plugin.echo", { text: "hello" }).catch(
      (value: unknown) => value,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    for (const text of [error, "MCP stderr tail:", ...expected]) {
      expect(message).toContain(text);
    }
    expect(message).not.toContain("old stderr");
    expect(closeMock).toHaveBeenCalled();
  },
);
