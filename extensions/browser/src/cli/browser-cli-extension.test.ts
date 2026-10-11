import { Command } from "commander";
import * as runtimeConfigSnapshot from "openclaw/plugin-sdk/runtime-config-snapshot";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import type { installChromeExtensionBootstrap } from "../browser/extension-install.js";
import { relayKeyIdFromHex } from "../browser/extension-relay/auth-v2-crypto.js";

// Metadata output must remain usable without loading browser or agent execution runtimes.
vi.mock("../control-service.js", () => {
  throw new Error("Browser extension CLI must not load browser control services");
});
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => {
  throw new Error("Browser extension CLI must not load agent runtime");
});
vi.mock("openclaw/plugin-sdk/media-runtime", () => {
  throw new Error("Browser extension CLI must not load media runtime");
});
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", () => {
  throw new Error("Browser extension CLI must not load media understanding runtime");
});

const relayMocks = vi.hoisted(() => {
  let relayKey = "";
  for (let byteIndex = 0; byteIndex < 32; byteIndex += 1) {
    relayKey += ((1 + byteIndex * 17) & 0xff).toString(16).padStart(2, "0");
  }
  return { relayKey, ensureExtensionRelayToken: vi.fn(() => relayKey) };
});
const installMocks = vi.hoisted(() => ({
  browserExtensionStatus: vi.fn(),
  installChromeExtensionBootstrap: vi.fn(),
  removeChromeStoreInstallRequests: vi.fn(),
  repairChromeExtensionNativeHosts: vi.fn(),
  uninstallChromeExtensionNativeHosts: vi.fn(),
}));

vi.mock("../browser/extension-relay/relay-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/extension-relay/relay-auth.js")>()),
  ensureExtensionRelayToken: relayMocks.ensureExtensionRelayToken,
}));

vi.mock("../browser/extension-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/extension-install.js")>()),
  browserExtensionStatus: installMocks.browserExtensionStatus,
  installChromeExtensionBootstrap: installMocks.installChromeExtensionBootstrap,
  removeChromeStoreInstallRequests: installMocks.removeChromeStoreInstallRequests,
  repairChromeExtensionNativeHosts: installMocks.repairChromeExtensionNativeHosts,
  uninstallChromeExtensionNativeHosts: installMocks.uninstallChromeExtensionNativeHosts,
}));

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

function createExtensionStatus() {
  return {
    platform: "linux" as const,
    platformSupport: "automatic" as const,
    installedCopy: { path: "/stable/openclaw-extension", present: true, owned: true },
    bundledPath: "/bundled/openclaw-extension",
    approvedPaths: ["/stable/openclaw-extension"],
    discovered: [],
    storeDiscovered: [],
    storeInstallRequests: [],
    registrations: [],
    manualSetupRequired: false,
    issues: [],
  };
}

async function run(args: string[], pluginRoot?: string) {
  const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
  const program = new Command().exitOverride();
  registerBrowserExtensionCommands(program.command("browser"), () => ({}), pluginRoot);
  return program.parseAsync(["browser", "extension", ...args], { from: "user" });
}

describe("browser extension pairing Gateway URL", () => {
  const output = {
    json: vi.fn(defaultRuntime.writeJson),
    log: vi.fn(defaultRuntime.log),
    error: vi.fn(defaultRuntime.error),
  };
  beforeEach(() => {
    vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue({});
    output.json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(runtime.writeJson);
    output.log = vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
    output.error = vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);
    installMocks.browserExtensionStatus.mockResolvedValue(createExtensionStatus());
    installMocks.installChromeExtensionBootstrap.mockResolvedValue(createExtensionStatus());
    installMocks.removeChromeStoreInstallRequests.mockResolvedValue({ removed: [], refused: [] });
    installMocks.uninstallChromeExtensionNativeHosts.mockResolvedValue({
      removed: [],
      refused: [],
      manualRequired: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    installMocks.browserExtensionStatus.mockReset();
    installMocks.installChromeExtensionBootstrap.mockReset();
    installMocks.removeChromeStoreInstallRequests.mockReset();
    installMocks.repairChromeExtensionNativeHosts.mockReset();
    installMocks.uninstallChromeExtensionNativeHosts.mockReset();
    resetRuntimeCapture();
  });

  it("repairs only the explicitly selected native target without profile discovery or pairing", async () => {
    const report = {
      changes: ["Repaired Google Chrome OpenClaw native messaging registration."],
      warnings: [],
      registrations: [],
      retainedNativeHostPaths: ["/new/native-host-entry.js"],
      retentionSafe: true,
      manualRequired: false,
    };
    installMocks.repairChromeExtensionNativeHosts.mockResolvedValue(report);
    await run(["repair", "--from", "/old/native-host-entry.js", "--json"], "/new/browser");
    expect(output.json).toHaveBeenCalledWith(report);
    expect(installMocks.repairChromeExtensionNativeHosts).toHaveBeenCalledWith({
      bundledDir: "/new/browser/chrome-extension",
      pluginRoot: "/new/browser",
      fromNativeHostPath: "/old/native-host-entry.js",
      dryRun: false,
    });
    expect(installMocks.browserExtensionStatus).not.toHaveBeenCalled();
    expect(installMocks.installChromeExtensionBootstrap).not.toHaveBeenCalled();
    expect(relayMocks.ensureExtensionRelayToken).not.toHaveBeenCalled();
  });

  it("prints the Store CTA only after native pre-registration is ready", async () => {
    installMocks.installChromeExtensionBootstrap.mockImplementation(
      async (params: Parameters<typeof installChromeExtensionBootstrap>[0]) => {
        params.onProgress?.("Pre-registered the native host for Chromium.");
        params.onProgress?.(
          "Native bootstrap is ready. Add OpenClaw from the Chrome Web Store. For development, load unpacked from /stable/openclaw-extension.",
        );
        return {
          ...createExtensionStatus(),
          discovered: [
            {
              product: "chromium",
              browser: "Chromium",
              userDataDir: "/chrome",
              profile: "Default",
              securePreferencesPath: "/chrome/Default/Secure Preferences",
              extensionId: "abcdefghijklmnopabcdefghijklmnop",
              extensionPath: "/stable/openclaw-extension",
            },
          ],
        };
      },
    );

    await run(["install", "--no-store", "--wait-ms", "1000"]);
    expect(installMocks.installChromeExtensionBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ requestStoreInstall: false }),
    );

    const messages = output.log.mock.calls.map(([message]) => String(message));
    expect(messages[0]).toContain("Preparing");
    expect(messages.findIndex((message) => message.includes("Pre-registered"))).toBeLessThan(
      messages.findIndex((message) => message.includes("Chrome Web Store")),
    );
    expect(messages.at(-1)).toContain("extension identity verified");
  });

  it("reports Chrome approval as pending without claiming connection", async () => {
    installMocks.installChromeExtensionBootstrap.mockResolvedValue({
      ...createExtensionStatus(),
      manualSetupRequired: true,
      storeInstallRequests: [
        {
          browser: "Google Chrome",
          path: "/chrome/External Extensions/openclaw.json",
          state: "requested",
        },
      ],
    });
    await expect(run(["install"])).rejects.toThrow("__exit__:1");
    expect(output.log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "approve Chrome's prompt",
    );
  });

  it("removes Store requests without removing native hosts", async () => {
    await run(["uninstall-store", "--json"]);
    expect(installMocks.removeChromeStoreInstallRequests).toHaveBeenCalledOnce();
    expect(installMocks.uninstallChromeExtensionNativeHosts).not.toHaveBeenCalled();
  });

  it("rejects an invalid install --wait-ms value before installation", async () => {
    await expect(run(["install", "--wait-ms", "0x1000"])).rejects.toThrow("__exit__:1");

    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("--wait-ms"));
    expect(installMocks.installChromeExtensionBootstrap).not.toHaveBeenCalled();
  });

  it("rejects path-rewriting proxy prefixes for strict v2 resource binding", async () => {
    await expect(
      run(["pair", "--gateway-url", "wss://gateway.example/proxy-prefix"]),
    ).rejects.toThrow("__exit__:1");
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("must not include a path prefix"),
    );
  });

  it.each(["status", "uninstall-host"])(
    "honors browser-level and leaf JSON placement for extension %s",
    async (subcommand) => {
      const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
      const placements = [
        ["browser", "--json", "extension", subcommand],
        ["browser", "extension", subcommand, "--json"],
      ];

      for (const argv of placements) {
        const program = new Command().enablePositionalOptions();
        const browser = program.command("browser").option("--json", "Output JSON", false);
        registerBrowserExtensionCommands(browser, (command) => {
          let owner: Command | null = command;
          while (owner && owner.name() !== "browser") {
            owner = owner.parent;
          }
          return owner?.opts() ?? {};
        });
        output.json.mockClear();
        output.log.mockClear();

        await program.parseAsync(argv, { from: "user" });

        expect(output.json, argv.join(" ")).toHaveBeenCalledTimes(1);
        expect(output.log, argv.join(" ")).not.toHaveBeenCalled();
      }
    },
  );

  it("pairs desktop helpers through the local Gateway wake-up route", async () => {
    vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue({
      gateway: { mode: "local" },
    });

    await run(["pair", "--local-gateway", "--json"]);

    expect(output.json).toHaveBeenCalledWith({
      pairingString: expect.stringContaining("/browser/extension?gateway="),
      relayPort: 18799,
      remote: false,
    });
    expect(output.log).not.toHaveBeenCalled();
  });

  it.each([
    { config: {}, args: ["--gateway-url", "wss://gateway.example"], message: "cannot be combined" },
    {
      config: { gateway: { mode: "remote" as const, remote: { url: "wss://gateway.example" } } },
      args: [],
      message: "requires a local Gateway",
    },
  ])(
    "rejects conflicting desktop pairing targets before reading a relay key",
    async ({ config, args, message }) => {
      vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue(config);
      relayMocks.ensureExtensionRelayToken.mockClear();

      await expect(run(["pair", "--local-gateway", "--json", ...args])).rejects.toThrow(
        "__exit__:1",
      );

      expect(output.error).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(relayMocks.ensureExtensionRelayToken).not.toHaveBeenCalled();
    },
  );

  it("pairs with the allocated extension relay when another profile pins the default port", async () => {
    vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue({
      browser: {
        profiles: {
          pinned: { cdpPort: 18799, color: "#00AA00" },
        },
      },
    });

    await run(["pair", "--json"]);

    expect(output.json).toHaveBeenCalledWith({
      pairingString: expect.stringContaining("127.0.0.1:18798/extension"),
      relayPort: 18798,
      remote: false,
    });
    expect(JSON.stringify(output.json.mock.calls)).toContain(`#${relayMocks.relayKey}`);
    expect(output.log).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "configured",
      config: {
        browser: {
          profiles: { custom: { driver: "extension" as const, cdpPort: 21117, color: "#00AA00" } },
        },
      },
      port: 21117,
    },
  ])("prints safe $label v2 metadata through the lazy root CLI", async ({ config, port }) => {
    vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue(config);
    const { registerBrowserCli } = await import("./browser-cli.js");
    const program = new Command();
    registerBrowserCli(program, ["node", "openclaw", "browser", "extension", "cdp", "--json"]);

    await program.parseAsync(["browser", "extension", "cdp", "--json"], { from: "user" });

    expect(output.json).toHaveBeenCalledWith({
      browserUrl: `http://127.0.0.1:${port}`,
      wsEndpoint: `ws://127.0.0.1:${port}/cdp`,
      auth: {
        label: "openclaw.browser-relay.auth",
        version: 2,
        keyId: relayKeyIdFromHex(relayMocks.relayKey),
        challengeUrl: `http://127.0.0.1:${port}/_openclaw/relay/auth/v2/challenge`,
        completeUrl: `http://127.0.0.1:${port}/_openclaw/relay/auth/v2/complete`,
        role: "cdp",
        transport: "connection",
        method: "SEQUENCE",
        resource: "/json/version -> /cdp",
        flow: "cdp",
      },
    });
    expect(JSON.stringify(output.json.mock.calls[0]?.[0])).not.toContain("Bearer");
    expect(JSON.stringify(output.json.mock.calls[0]?.[0])).not.toContain(relayMocks.relayKey);
    expect(output.log).not.toHaveBeenCalled();
  });

  it("prints an explicit warned legacy bearer only while legacy auth is enabled", async () => {
    await run(["cdp", "--legacy-bearer", "--json"]);

    expect(output.json).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: `Bearer ${relayMocks.relayKey}` },
      }),
    );
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("reveals the relay key"));
  });

  it("refuses --legacy-bearer when legacy auth is disabled", async () => {
    vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue({
      browser: { extensionRelay: { allowLegacyAuth: false } },
    });

    await expect(run(["cdp", "--legacy-bearer", "--json"])).rejects.toThrow("__exit__:1");

    expect(output.json).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("Legacy browser relay auth is disabled"),
    );
    expect(output.error.mock.calls.flat().join("\n")).not.toContain(relayMocks.relayKey);
  });
});
