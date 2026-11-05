import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { installChromeExtensionBootstrap } from "../browser/extension-install.js";
import { relayKeyIdFromHex } from "../browser/extension-relay/auth-v2-crypto.js";
import { createBrowserCliCapture } from "./browser-cli-extension.test-support.js";

// Metadata output must remain usable without loading browser or agent execution runtimes.
const rejectRuntimeImport = vi.hoisted(() => () => {
  throw new Error("Browser extension metadata must not load execution runtimes");
});
// mock-isolation: fail if metadata commands load the browser control runtime.
vi.mock("../control-service.js", rejectRuntimeImport);
// mock-isolation: fail if metadata commands load the agent execution runtime.
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", rejectRuntimeImport);
// mock-isolation: fail if metadata commands load the media execution runtime.
vi.mock("openclaw/plugin-sdk/media-runtime", rejectRuntimeImport);
// mock-isolation: fail if metadata commands load the media understanding runtime.
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", rejectRuntimeImport);

const relayMocks = vi.hoisted(() => {
  const relayKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (1 + i * 17) & 0xff)).toString(
    "hex",
  );
  return { relayKey, ensureExtensionRelayToken: vi.fn(() => relayKey) };
});
const installMocks = vi.hoisted(() => ({
  browserExtensionStatus: vi.fn(),
  installChromeExtensionBootstrap: vi.fn(),
  removeChromeStoreInstallRequests: vi.fn(),
  repairChromeExtensionNativeHosts: vi.fn(),
  uninstallChromeExtensionNativeHosts: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({ read: vi.fn<() => OpenClawConfig>() }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => configMocks.read(),
}));

vi.mock("../browser/extension-relay/relay-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/extension-relay/relay-auth.js")>()),
  ensureExtensionRelayToken: relayMocks.ensureExtensionRelayToken,
}));

vi.mock("../browser/extension-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/extension-install.js")>()),
  ...installMocks,
}));

const { installRuntime, resetRuntimeCapture } = createBrowserCliCapture();

const createExtensionStatus = () => ({
  platformSupport: "automatic" as const,
  discovered: [],
  storeDiscovered: [],
  storeInstallRequests: [],
  manualSetupRequired: false,
  issues: [],
});

async function run(args: string[], pluginRoot?: string, parentJson = false) {
  const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
  const program = new Command().exitOverride().enablePositionalOptions();
  const browser = program.command("browser").option("--json", "Output JSON", false);
  registerBrowserExtensionCommands(browser, () => browser.opts(), pluginRoot);
  return program.parseAsync(["browser", ...(parentJson ? ["--json"] : []), "extension", ...args], {
    from: "user",
  });
}

describe("browser extension pairing Gateway URL", () => {
  let output: ReturnType<typeof installRuntime>;
  const loggedMessages = () => output.log.mock.calls.map(([message]) => String(message));
  async function expectFailure(args: string[], message: string) {
    await expect(run(args)).rejects.toThrow("__exit__:1");
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining(message));
  }
  beforeEach(() => {
    configMocks.read.mockReset().mockReturnValue({});
    output = installRuntime();
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
    for (const mock of Object.values(installMocks)) {
      mock.mockReset();
    }
    resetRuntimeCapture();
  });

  it("repairs only the explicitly selected native target without profile discovery or pairing", async () => {
    const report = { warnings: [], retentionSafe: true, manualRequired: false };
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
        return createExtensionStatus();
      },
    );

    await run(["install", "--no-store", "--wait-ms", "1000"]);
    expect(installMocks.installChromeExtensionBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ requestStoreInstall: false }),
    );

    const messages = loggedMessages();
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
      storeInstallRequests: [{ state: "requested" }],
    });
    await expect(run(["install"])).rejects.toThrow("__exit__:1");
    expect(loggedMessages().join("\n")).toContain("approve Chrome's prompt");
  });

  it("removes Store requests without removing native hosts", async () => {
    await run(["uninstall-store", "--json"]);
    expect(installMocks.removeChromeStoreInstallRequests).toHaveBeenCalledOnce();
    expect(installMocks.uninstallChromeExtensionNativeHosts).not.toHaveBeenCalled();
  });

  it("rejects path-rewriting proxy prefixes for strict v2 resource binding", async () => {
    await expectFailure(
      ["pair", "--gateway-url", "wss://gateway.example/proxy-prefix"],
      "must not include a path prefix",
    );
  });

  it.each(["status", "uninstall-host"])(
    "honors browser-level and leaf JSON placement for extension %s",
    async (subcommand) => {
      for (const parentJson of [true, false]) {
        output.json.mockClear();
        output.log.mockClear();
        await run(parentJson ? [subcommand] : [subcommand, "--json"], undefined, parentJson);
        expect(output.json).toHaveBeenCalledTimes(1);
        expect(output.log).not.toHaveBeenCalled();
      }
    },
  );

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
      configMocks.read.mockReturnValue(config);
      relayMocks.ensureExtensionRelayToken.mockClear();

      await expectFailure(["pair", "--local-gateway", "--json", ...args], message);
      expect(relayMocks.ensureExtensionRelayToken).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      config: { gateway: { mode: "local" as const } },
      args: ["--local-gateway"],
      port: 18799,
      route: "/browser/extension?gateway=",
    },
    {
      config: { browser: { profiles: { pinned: { cdpPort: 18799, color: "#00AA00" } } } },
      args: [],
      port: 18798,
      route: "127.0.0.1:18798/extension",
    },
  ])("pairs through $route on port $port", async ({ config, args, port, route }) => {
    configMocks.read.mockReturnValue(config);
    await run(["pair", "--json", ...args]);
    expect(output.json).toHaveBeenCalledWith({
      pairingString: expect.stringContaining(route),
      relayPort: port,
      remote: false,
    });
    expect(JSON.stringify(output.json.mock.calls)).toContain(`#${relayMocks.relayKey}`);
    expect(output.log).not.toHaveBeenCalled();
  });

  it("prints safe configured v2 metadata through the lazy root CLI", async () => {
    const port = 21117;
    configMocks.read.mockReturnValue({
      browser: { profiles: { custom: { driver: "extension", cdpPort: port, color: "#00AA00" } } },
    });
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
    configMocks.read.mockReturnValue({ browser: { extensionRelay: { allowLegacyAuth: false } } });

    await expectFailure(
      ["cdp", "--legacy-bearer", "--json"],
      "Legacy browser relay auth is disabled",
    );
    expect(output.json).not.toHaveBeenCalled();
    expect(output.error.mock.calls.flat().join("\n")).not.toContain(relayMocks.relayKey);
  });
});
