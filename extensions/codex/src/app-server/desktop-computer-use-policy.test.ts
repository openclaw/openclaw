import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as desktopPaths from "./desktop-app-paths.js";
import { assertCodexDesktopComputerUseProbeSupported } from "./desktop-computer-use-policy.js";

describe("desktop Computer Use candidate ownership", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());
  async function fixture() {
    const root = dirs.make("codex-computer-use-policy-");
    const home = path.join(root, "agent/codex-home");
    const resources = path.join(root, "staged/ChatGPT.app/Contents/Resources");
    await fs.mkdir(path.join(resources, "plugins/openai-bundled/plugins/computer-use"), {
      recursive: true,
    });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[plugins."computer-use@openai-bundled"]\nenabled=true\n',
    );
    return {
      root,
      home,
      params: { appServerCommand: path.join(resources, "codex"), codexHome: home },
    };
  }

  it.each([
    '[plugins."computer-use@openai-bundled"]\nenabled = false',
    '[features]\nplugins = false\n[plugins."computer-use@openai-bundled"]\nenabled = true',
    '[features]\ncomputer_use = false\n[plugins."computer-use@openai-bundled"]\nenabled = true',
    '[plugins."computer-use@openai-bundled"]\nenabled = true\n[mcp_servers.node_repl]\nenabled = false',
    '[plugins."computer-use@openai-bundled"]\nenabled = true\n[marketplaces.openai-bundled]\nsource_type = "remote"\nsource = "custom"',
  ])("preserves native ownership: %s", async (codexConfigToml) => {
    const { params } = await fixture();
    const args = ["app-server"];
    await fs.writeFile(path.join(params.codexHome, "config.toml"), codexConfigToml);
    await expect(
      assertCodexDesktopComputerUseProbeSupported({
        ...params,
        args,
        enabled: true,
      }),
    ).rejects.toThrow("cannot be updated automatically");
  });

  it.each([
    ["-c", "mcp_servers.node_repl={enabled=false}", "app-server"],
    ["-p", "custom", "app-server"],
    ["-c", "features.computer_use=false", "app-server"],
  ])("leaves explicit launch overrides unchanged", async (...args) => {
    const { params } = await fixture();
    await expect(assertCodexDesktopComputerUseProbeSupported({ ...params, args })).rejects.toThrow(
      "launch override",
    );
  });

  it("accepts standard process auth flags and does not require native config for explicit enablement", async () => {
    const { params } = await fixture();
    await fs.writeFile(path.join(params.codexHome, "config.toml"), "");
    await expect(
      assertCodexDesktopComputerUseProbeSupported({
        ...params,
        enabled: true,
        args: ["-c", 'cli_auth_credentials_store="ephemeral"', "app-server"],
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves an owned previous-generation wrapper while checking the candidate", async () => {
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
    await expect(assertCodexDesktopComputerUseProbeSupported(params)).resolves.toBeUndefined();
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
});
