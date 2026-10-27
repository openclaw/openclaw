import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as jsonReader from "@openclaw/fs-safe/json";
import { describe, expect, it, vi } from "vitest";
import { CODEX_ACP_PACKAGE, OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { useAuthBridgeFixture } from "./codex-auth-bridge.test-support.js";
import { splitCommandParts } from "./command-line.js";

vi.mock("@openclaw/fs-safe/json", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/json")>()),
}));
const execFileAsync = promisify(execFile);
const fixture = useAuthBridgeFixture((bin) =>
  vi.spyOn(jsonReader, "tryReadJson").mockResolvedValueOnce({ name: CODEX_ACP_PACKAGE, bin }),
);
const startup = { model: "gpt-5.6-sol", model_reasoning_effort: "medium" };
const mcp = { "foo.bar": { command: "node", args: ["server.js"] } };
const migrated = { model: "gpt-5.4", model_reasoning_effort: "high", mcp_servers: mcp };
const maintainedArgs = [
  "cli",
  "-c",
  'model="gpt-5.6-sol"',
  "--config",
  'model_reasoning_effort="low"',
];

describe("prepareAcpxCodexAuthConfig command migration", () => {
  it("migrates config flags from a bare Codex ACP executable", async () => {
    const { root, config, generated, prepare } = fixture();
    const resolved = await prepare(
      { pluginConfig: config("codex-acp -cmodel='\"gpt-5.4\"'") },
      path.join(root, "codex-acp.js"),
    );
    expect(splitCommandParts(resolved.agents.codex ?? "")).toEqual([
      process.execPath,
      generated.wrapperPath,
      OPENCLAW_CODEX_CONFIG_ARG,
      JSON.stringify({ model: "gpt-5.4" }),
    ]);
  });

  it("normalizes an explicitly configured Claude ACP npx command to the local wrapper", async () => {
    const { stateDir, config } = fixture();
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig: config(
        "npx -y @agentclientprotocol/claude-agent-acp@0.31.4 --permission-mode bypass",
        "claude",
      ),
      stateDir,
    });
    expect(resolved.agents.claude).toEqual([
      process.execPath,
      path.join(stateDir, "acpx", "claude-agent-acp-wrapper.mjs"),
      "--permission-mode",
      "bypass",
    ]);
  });

  it.each([
    {
      name: "Zed package config",
      command:
        'npx @zed-industries/codex-acp@0.12.0 -c=model=\'"gpt-5.4"\' -cmodel_reasoning_effort=\'"high"\' --config=\'mcp_servers."foo.bar"={ command = "node", args = ["server.js"] }\'',
      forwarded: [],
      config: { ...startup, mcp_servers: mcp },
    },
    {
      name: "maintained package flags",
      command:
        "npx @agentclientprotocol/codex-acp@1.1.2 cli -c 'model=\"gpt-5.6-sol\"' --config 'model_reasoning_effort=\"low\"'",
      forwarded: maintainedArgs,
      config: startup,
    },
  ])("launches $name through the isolated wrapper", async (row) => {
    const { root, config, generated, prepare, sourceConfig } = fixture();
    await sourceConfig("");
    const bin = path.join(root, "codex-acp.js");
    await fs.writeFile(
      bin,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), config: process.env.CODEX_CONFIG }));\n",
    );
    const resolved = await prepare({ pluginConfig: config(row.command) }, bin);
    const [command, ...args] = splitCommandParts(resolved.agents.codex ?? "");
    const isolated = await fs.readFile(generated.configPath, "utf8");
    if (row.name === "Zed package config") {
      expect(JSON.parse(args[2]!)).toEqual(migrated);
      expect(isolated).toContain('[mcp_servers."foo.bar"]');
      expect(isolated).toContain('command = "node"');
    }
    const { stdout } = await execFileAsync(
      command!,
      [...args, OPENCLAW_CODEX_CONFIG_ARG, JSON.stringify(startup)],
      { cwd: root, env: { ...process.env, CODEX_CONFIG: "" } },
    );
    const launched: { argv?: unknown; config?: unknown } = JSON.parse(stdout);
    expect(launched.argv).toEqual(row.forwarded);
    expect(JSON.parse(String(launched.config))).toEqual(row.config);
  });

  it("does not carry migrated MCP config across isolated Codex homes or rebuilds", async () => {
    const { root, config, prepare, sourceConfig } = fixture();
    const legacy = path.join(root, "legacy-state");
    const maintained = path.join(root, "maintained-state");
    const read = (dir: string) =>
      fs.readFile(path.join(dir, "acpx/codex-home/config.toml"), "utf8");
    await sourceConfig("");
    await prepare({
      pluginConfig: config(
        "npx @zed-industries/codex-acp@0.12.0 --config='mcp_servers.legacy={ command = \"node\" }'",
      ),
      stateDir: legacy,
    });
    await prepare({ stateDir: maintained });
    expect(await read(legacy)).toContain("[mcp_servers.legacy]");
    expect(await read(maintained)).not.toContain("mcp_servers");
    await prepare({ stateDir: legacy });
    expect(await read(legacy)).not.toContain("mcp_servers");
  });
});
