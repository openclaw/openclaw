import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as jsonReader from "@openclaw/fs-safe/json";
import { describe, expect, it, vi } from "vitest";
import { CODEX_ACP_PACKAGE, OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { useAuthBridgeFixture } from "./codex-auth-bridge.test-support.js";
import { splitCommandParts, type AcpxAgentCommand } from "./command-line.js";

vi.mock("@openclaw/fs-safe/json", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/json")>()),
}));

const execFileAsync = promisify(execFile);
const baseFixture = useAuthBridgeFixture((codexBin) =>
  vi
    .spyOn(jsonReader, "tryReadJson")
    .mockResolvedValueOnce({ name: CODEX_ACP_PACKAGE, bin: codexBin }),
);

function fixture() {
  const { root, stateDir, config, prepare, sourceConfig } = baseFixture();
  return {
    root,
    stateDir,
    config,
    sourceConfig,
    configPath: (dir = stateDir) => path.join(dir, "acpx", "codex-home", "config.toml"),
    wrapperPath: (agent = "codex") => path.join(stateDir, "acpx", `${agent}-acp-wrapper.mjs`),
    prepare: (pluginConfig = config(), dir = stateDir, bin?: string) =>
      prepare({ pluginConfig, stateDir: dir }, bin),
  };
}

function expectWrapperCommand(command: AcpxAgentCommand | undefined, wrapperPath: string): void {
  expect(command).toEqual(expect.arrayContaining([process.execPath, wrapperPath]));
}

async function writeAdapter(root: string) {
  const bin = path.join(root, "codex-acp.js");
  await fs.writeFile(
    bin,
    "console.log(JSON.stringify({ argv: process.argv.slice(2), codexConfig: process.env.CODEX_CONFIG }));\n",
    "utf8",
  );
  return bin;
}

async function launch(command: AcpxAgentCommand | undefined, root: string, env = process.env) {
  const [nodePath, wrapperPath, ...args] = splitCommandParts(command ?? "");
  if (!nodePath || !wrapperPath) {
    throw new Error("expected generated Codex ACP wrapper command");
  }
  const { stdout } = await execFileAsync(
    nodePath,
    [
      wrapperPath,
      ...args,
      OPENCLAW_CODEX_CONFIG_ARG,
      JSON.stringify({ model: "gpt-5.6-sol", model_reasoning_effort: "medium" }),
    ],
    { cwd: root, env },
  );
  return JSON.parse(stdout.trim()) as { argv?: unknown; codexConfig?: unknown };
}

describe("prepareAcpxCodexAuthConfig command migration", () => {
  it("migrates an explicitly configured Zed Codex ACP command to the local wrapper", async () => {
    const { root, config, configPath, wrapperPath, prepare, sourceConfig } = fixture();
    const sourceCodexHome = await sourceConfig('notify = ["SkyComputerUseClient", "turn-ended"]\n');
    const pluginConfig = config(
      'npx @zed-industries/codex-acp@0.12.0 -c=model=\'"gpt-5.4"\' -cmodel_reasoning_effort=\'"high"\' --config=\'mcp_servers."foo.bar"={ command = "node", args = ["server.js"] }\'',
    );
    const resolved = await prepare(pluginConfig, undefined, await writeAdapter(root));

    expectWrapperCommand(resolved.agents.codex, wrapperPath());
    expect(splitCommandParts(resolved.agents.codex ?? "").slice(2)).toEqual([
      OPENCLAW_CODEX_CONFIG_ARG,
      JSON.stringify({
        model: "gpt-5.4",
        model_reasoning_effort: "high",
        mcp_servers: { "foo.bar": { command: "node", args: ["server.js"] } },
      }),
    ]);
    const isolatedConfig = await fs.readFile(configPath(), "utf8");
    expect(isolatedConfig).toContain('[mcp_servers."foo.bar"]');
    expect(isolatedConfig).toContain('command = "node"');
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
    expect(await fs.readFile(wrapperPath(), "utf8")).not.toContain(sourceCodexHome);
    const launched = await launch(resolved.agents.codex, root);
    expect(launched.argv).toStrictEqual([]);
    expect(JSON.parse(String(launched.codexConfig))).toEqual({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "medium",
      mcp_servers: { "foo.bar": { command: "node", args: ["server.js"] } },
    });
  });

  it("forwards maintained Codex ACP config flags without legacy migration", async () => {
    const { root, config, wrapperPath, prepare } = fixture();
    const pluginConfig = config(
      "npx @agentclientprotocol/codex-acp@1.1.2 cli -c 'model=\"gpt-5.6-sol\"' --config 'model_reasoning_effort=\"low\"'",
    );
    const resolved = await prepare(pluginConfig, undefined, await writeAdapter(root));

    expectWrapperCommand(resolved.agents.codex, wrapperPath());
    const commandParts = splitCommandParts(resolved.agents.codex ?? "");
    expect(commandParts.slice(2)).toStrictEqual([
      "cli",
      "-c",
      'model="gpt-5.6-sol"',
      "--config",
      'model_reasoning_effort="low"',
    ]);

    const launched = await launch(resolved.agents.codex, root, {
      ...process.env,
      CODEX_CONFIG: "",
    });
    expect(launched.argv).toStrictEqual(commandParts.slice(2));
    expect(JSON.parse(String(launched.codexConfig))).toEqual({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "medium",
    });
  });

  it("does not carry migrated MCP config across isolated Codex homes or rebuilds", async () => {
    const { root, config, configPath, prepare, sourceConfig } = fixture();
    const legacyStateDir = path.join(root, "legacy-state");
    const maintainedStateDir = path.join(root, "maintained-state");
    await sourceConfig("");
    const legacyConfig = config(
      "npx @zed-industries/codex-acp@0.12.0 --config='mcp_servers.legacy={ command = \"node\" }'",
    );
    await prepare(legacyConfig, legacyStateDir);
    await prepare(config(), maintainedStateDir);

    expect(await fs.readFile(configPath(legacyStateDir), "utf8")).toContain("[mcp_servers.legacy]");
    expect(await fs.readFile(configPath(maintainedStateDir), "utf8")).not.toContain("mcp_servers");

    await prepare(config(), legacyStateDir);
    expect(await fs.readFile(configPath(legacyStateDir), "utf8")).not.toContain("mcp_servers");
  });

  it("migrates config flags from a bare Codex ACP executable", async () => {
    const { root, config, wrapperPath, prepare } = fixture();
    const resolved = await prepare(
      config("codex-acp -cmodel='\"gpt-5.4\"'"),
      undefined,
      path.join(root, "codex-acp.js"),
    );

    expectWrapperCommand(resolved.agents.codex, wrapperPath());
    expect(splitCommandParts(resolved.agents.codex ?? "").slice(2)).toEqual([
      OPENCLAW_CODEX_CONFIG_ARG,
      JSON.stringify({ model: "gpt-5.4" }),
    ]);
  });

  it("normalizes an explicitly configured Claude ACP npx command to the local wrapper", async () => {
    const { stateDir, config, wrapperPath } = fixture();
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig: config(
        "npx -y @agentclientprotocol/claude-agent-acp@0.31.4 --permission-mode bypass",
        "claude",
      ),
      stateDir,
    });

    expect(resolved.agents.claude).toEqual([
      process.execPath,
      wrapperPath("claude-agent"),
      "--permission-mode",
      "bypass",
    ]);
  });
});
