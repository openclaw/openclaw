import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCodexDesktopComputerUseProbeSupported,
  bindCodexComputerUseNodeReplClient,
  hasCodexComputerUseNodeReplOwnership,
  isCodexComputerUseNodeReplClient,
  resolveCodexComputerUseNodeReplStartArgs,
} from "./computer-use-node-repl.js";
import { requireRecord } from "./computer-use.test-support.js";
import * as desktopPaths from "./desktop-app-paths.js";

describe("desktop Computer Use node_repl process config", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-node-repl-"));
    roots.push(root);
    const resources = path.join(root, "staged/ChatGPT.app/Contents/Resources");
    const home = path.join(root, "agent/codex-home");
    const plugin = path.join(resources, "plugins/openai-bundled/plugins/computer-use");
    const service = path.join(home, "computer-use/Codex Computer Use.app");
    for (const [file, text] of [
      [path.join(plugin, "skills/computer-use/SKILL.md"), "Use node_repl with @oai/sky."],
      [path.join(resources, "cua_node/bin/node"), "node"],
      [path.join(resources, "cua_node/bin/node_repl"), "repl"],
      [path.join(resources, "cua_node/lib/node_modules/@oai/sky/package.json"), "{}"],
      [path.join(service, "Contents/Info.plist"), "fixture"],
      [path.join(home, "config.toml"), '[plugins."computer-use@openai-bundled"]\nenabled = true\n'],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, { mode: 0o700 });
    }
    return {
      plugin,
      root,
      service,
      home,
      params: {
        appServerCommand: path.join(resources, "codex"),
        codexHome: home,
        platform: "darwin" as const,
      },
    };
  }

  it.each(["official", "copied args", "changed args", "other command", "other home"])(
    "binds only the actual canonical launch (%s)",
    async (scenario) => {
      const { params, home } = await fixture();
      const args = await resolveCodexComputerUseNodeReplStartArgs(params);
      const config = parseToml(args.filter((_, index) => args[index - 1] === "-c").join("\n"));
      const request = vi.fn(async () => ({ config }));
      const client = {};
      const start = {
        transport: "stdio",
        command: params.appServerCommand,
        args,
        env: { CODEX_HOME: home },
      };
      if (scenario === "copied args") {
        start.args = [...args];
      } else if (scenario === "changed args") {
        args.push("-c", 'mcp_servers.node_repl.command="/custom/server"');
      } else if (scenario === "other command") {
        start.command = "/custom/codex";
      } else if (scenario === "other home") {
        start.env.CODEX_HOME = "/custom/home";
      }
      bindCodexComputerUseNodeReplClient(client, start);
      expect(isCodexComputerUseNodeReplClient(client)).toBe(scenario === "official");
      await expect(hasCodexComputerUseNodeReplOwnership({ client, request })).resolves.toBe(
        scenario === "official",
      );
      expect(request).toHaveBeenCalledTimes(scenario === "official" ? 1 : 0);
    },
  );

  it.each([
    ["command", "/custom/node_repl"],
    ["args", ["--custom"]],
    ["env", { SKY_CUA_SERVICE_PATH: "/custom/service" }],
    ["env_vars", ["NODE_OPTIONS"]],
    ["environment_id", "remote-environment"],
    ["url", "https://custom.invalid/mcp"],
    ["cwd", "/custom/workdir"],
    ["enabled", false],
  ] as const)("rejects changed effective MCP %s after an admitted launch", async (key, value) => {
    const { params, home } = await fixture();
    const args = await resolveCodexComputerUseNodeReplStartArgs(params);
    const config = parseToml(args.filter((_, index) => args[index - 1] === "-c").join("\n"));
    const server = requireRecord(requireRecord(config.mcp_servers, "servers").node_repl, "server");
    const client = {};
    bindCodexComputerUseNodeReplClient(client, {
      transport: "stdio",
      command: params.appServerCommand,
      args,
      env: { CODEX_HOME: home },
    });
    server[key] = value;
    expect(isCodexComputerUseNodeReplClient(client)).toBe(true);
    const request = vi.fn(async () => ({ config }));
    await expect(hasCodexComputerUseNodeReplOwnership({ client, request })).resolves.toBe(false);
    expect(request).toHaveBeenCalledExactlyOnceWith("config/read", { includeLayers: false });
  });

  it.each([undefined, false])(
    "wires an enabled native plugin without changing config or service (OpenClaw enabled: %s)",
    async (enabled) => {
      const { params, home, service } = await fixture();
      const before = await fs.readFile(path.join(home, "config.toml"), "utf8");
      const args = await resolveCodexComputerUseNodeReplStartArgs({ ...params, enabled });
      const config = parseToml(args.filter((_, index) => args[index - 1] === "-c").join("\n")) as {
        mcp_servers: { node_repl: { command: string; env: Record<string, string> } };
      };
      expect(config.mcp_servers.node_repl.command).toContain(
        "staged/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
      );
      expect(config.mcp_servers.node_repl.env).toMatchObject({
        CODEX_HOME: home,
        CODEX_CLI_PATH: params.appServerCommand,
        SKY_CUA_SERVICE_PATH: service,
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
      });
      expect(args.some((arg) => arg.startsWith("marketplaces."))).toBe(false);
      expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(before);
      expect(await fs.readFile(path.join(service, "Contents/Info.plist"), "utf8")).toBe("fixture");
    },
  );

  it.each([
    '[plugins."computer-use@openai-bundled"]\nenabled = false',
    '[features]\nplugins = false\n[plugins."computer-use@openai-bundled"]\nenabled = true',
    '[features]\ncomputer_use = false\n[plugins."computer-use@openai-bundled"]\nenabled = true',
    '[plugins."computer-use@openai-bundled"]\nenabled = true\n[mcp_servers.node_repl]\nenabled = false',
    '[plugins."computer-use@openai-bundled"]\nenabled = true\n[marketplaces.openai-bundled]\nsource_type = "remote"\nsource = "custom"',
  ])("preserves native ownership: %s", async (codexConfigToml) => {
    const { params } = await fixture();
    const args = ["app-server"];
    expect(
      await resolveCodexComputerUseNodeReplStartArgs({
        ...params,
        args,
        enabled: true,
        codexConfigToml,
      }),
    ).toBe(args);
    await expect(
      assertCodexDesktopComputerUseProbeSupported({
        ...params,
        args,
        enabled: true,
        codexConfigToml,
      }),
    ).rejects.toThrow("cannot be updated automatically");
  });

  it.each([
    ["-c", "mcp_servers.node_repl={enabled=false}", "app-server"],
    ["-p", "custom", "app-server"],
    ["-c", "features.computer_use=false", "app-server"],
  ])("leaves explicit launch overrides unchanged", async (...args) => {
    const { params } = await fixture();
    expect(await resolveCodexComputerUseNodeReplStartArgs({ ...params, args })).toBe(args);
    await expect(assertCodexDesktopComputerUseProbeSupported({ ...params, args })).rejects.toThrow(
      "launch override",
    );
  });

  it("accepts standard process auth flags and does not require native config for explicit enablement", async () => {
    const { params } = await fixture();
    await expect(
      assertCodexDesktopComputerUseProbeSupported({
        ...params,
        codexConfigToml: "",
        enabled: true,
        args: ["-c", 'cli_auth_credentials_store="ephemeral"', "app-server"],
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves an owned previous-generation wrapper while preparing the bridge", async () => {
    const { params, root, home } = await fixture();
    const previousBundle = path.join(root, "previous/ChatGPT.app");
    const previousMarketplace = path.join(
      previousBundle,
      "Contents/Resources/plugins/openai-bundled",
    );
    await fs.mkdir(path.join(previousMarketplace, "plugins/computer-use"), { recursive: true });
    const wrapper = path.join(home, ".tmp/bundled-marketplaces/openai-bundled");
    await fs.mkdir(wrapper, { recursive: true });
    await fs.symlink(path.join(previousMarketplace, "plugins"), path.join(wrapper, "plugins"));
    const owner = {
      appName: "ChatGPT.app" as const,
      appBundlePath: previousBundle,
      appServerCommandPath: path.join(previousBundle, "Contents/Resources/codex"),
      bundledMarketplacePath: previousMarketplace,
      computerUseServiceAppPaths: [],
    };
    vi.spyOn(desktopPaths, "resolveMacOSDesktopCodexAppPathCandidateForBundle").mockReturnValue(
      owner,
    );
    const config = `[plugins."computer-use@openai-bundled"]\nenabled=true\n[marketplaces.openai-bundled]\nsource_type="local"\nsource=${JSON.stringify(wrapper)}\n`;
    await fs.writeFile(path.join(home, "config.toml"), config);
    const args = await resolveCodexComputerUseNodeReplStartArgs(params);
    const overrides = parseToml(args.filter((_, index) => args[index - 1] === "-c").join("\n"));
    expect(overrides.marketplaces).toBeUndefined();
    expect(overrides.mcp_servers).toHaveProperty("node_repl");
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(config);
    expect(desktopPaths.resolveMacOSDesktopCodexAppPathCandidateForBundle).toHaveBeenCalledWith(
      await fs.realpath(previousBundle),
    );
    vi.mocked(desktopPaths.resolveMacOSDesktopCodexAppPathCandidateForBundle).mockReturnValue(
      undefined,
    );
    await expect(assertCodexDesktopComputerUseProbeSupported(params)).rejects.toThrow(
      "owned desktop generation",
    );
  });

  it("does not install a missing service when auto provisioning has not run", async () => {
    const { params, service } = await fixture();
    await fs.rm(service, { recursive: true });
    const args = ["app-server"];
    expect(await resolveCodexComputerUseNodeReplStartArgs({ ...params, args })).toBe(args);
    await expect(fs.stat(service)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps legacy plugin MCP wiring unchanged", async () => {
    const { params, plugin } = await fixture();
    await fs.writeFile(path.join(plugin, ".mcp.json"), "{}");
    const args = ["app-server"];
    expect(await resolveCodexComputerUseNodeReplStartArgs({ ...params, args })).toBe(args);
  });
});
