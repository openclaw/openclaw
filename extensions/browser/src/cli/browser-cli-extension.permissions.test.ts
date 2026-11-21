import "../browser/extension-install-fixture.test-support.js";
import fs from "node:fs/promises";
import { Command } from "commander";
import { inspectPathPermissions } from "openclaw/plugin-sdk/file-access-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallFixture } from "../browser/extension-install-fixture.test-support.js";
import { useExtensionInstallFixture } from "../browser/extension-install.test-support.js";
import type { runWindowsManagement } from "../browser/extension-windows-management.js";
import { windowsFixture } from "../browser/extension-windows.test-support.js";
import { createBrowserCliCapture } from "./browser-cli-extension.test-support.js";

const boundary = vi.hoisted(() => ({
  deps: undefined as InstallFixture | undefined,
  readToken: vi.fn(),
  ensureToken: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));
vi.mock("../browser/extension-install.js", async (original) => {
  const real = await original<typeof import("../browser/extension-install.js")>();
  const fixture = await import("../browser/extension-install-fixture.test-support.js");
  return {
    ...real,
    browserExtensionStatus: (params: Parameters<typeof real.browserExtensionStatus>[0]) =>
      fixture.browserExtensionStatus({ ...params, deps: boundary.deps }),
    installChromeExtensionBootstrap: (
      params: Parameters<typeof real.installChromeExtensionBootstrap>[0],
    ) => fixture.installChromeExtensionBootstrap({ ...params, deps: boundary.deps }),
  };
});
vi.mock("../browser/extension-relay/relay-auth.js", async (original) => ({
  ...(await original<typeof import("../browser/extension-relay/relay-auth.js")>()),
  readExtensionRelayToken: boundary.readToken,
  ensureExtensionRelayToken: boundary.ensureToken,
}));
vi.mock("../browser/extension-relay/owner-client.js", async (original) => ({
  ...(await original<typeof import("../browser/extension-relay/owner-client.js")>()),
  RelayOwnerClient: { connect: boundary.connect },
}));

const fixture = useExtensionInstallFixture();
const { installRuntime, resetRuntimeCapture } = createBrowserCliCapture();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArgv = process.argv;
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  boundary.deps = undefined;
  resetRuntimeCapture();
});

const safe = {
  ok: true,
  source: "windows-acl",
  isSymlink: false,
  isDir: true,
  mode: null,
  bits: null,
  ownerTrusted: true,
  groupWritable: false,
  worldWritable: false,
  groupReadable: true,
  worldReadable: true,
} as const;
const unverifiedMessage =
  "Cannot verify Windows owner or ACL: permission inspection is unavailable or incomplete. Chrome extension setup remains blocked. Collect the OpenClaw version and this diagnostic for the installation maintainer. Do not loosen permissions to bypass verification.";
const unsafeMessage =
  "Refusing unsafe Windows owner or ACL: the permission check reported an untrusted owner or group/world write access. Ask the installation maintainer to review ownership and write permissions before retrying.";

async function setup() {
  const local = await fixture("win32");
  const windows = windowsFixture();
  const manage = vi.fn<typeof runWindowsManagement>(async (_exe, request) => {
    if (!request.context) {
      throw new Error("Windows management fixture requires a native context");
    }
    windows.prepare(request.context, request.expectedOrigins);
    return windows.response;
  });
  boundary.deps = {
    ...local.deps,
    // Keep permission facts with this regression rather than the fixture's Windows allow default.
    platform: undefined,
    windowsNative: {
      platform: windows.ops,
      context: windows.context,
      executable: windows.executable,
      manage,
    },
  };
  vi.mocked(inspectPathPermissions).mockResolvedValue(safe);
  boundary.readToken.mockReturnValue(undefined);
  const { json, log, error, exit } = installRuntime();
  const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  async function run(action: string, jsonMode: boolean) {
    const program = new Command().enablePositionalOptions();
    const browser = program.command("browser").option("--browser-profile <name>");
    registerBrowserExtensionCommands(browser, () => browser.opts(), local.pluginRoot);
    const args = [
      "browser",
      "--browser-profile",
      "chrome",
      "extension",
      "setup",
      "--action",
      action,
      ...(jsonMode ? ["--json"] : []),
    ];
    process.argv = ["node", "openclaw", ...args];
    await program.parseAsync(args, { from: "user" });
  }
  return { local, windows, manage, json, log, error, exit, run };
}

describe.each(["inspect", "install", "verify"])(
  "Windows source admission for setup %s",
  (action) => {
    it.each<{
      name: string;
      permissions: Awaited<ReturnType<typeof inspectPathPermissions>>;
      unverified: boolean;
    }>([
      {
        name: "incomplete descriptor",
        permissions: { ...safe, source: "unknown" },
        unverified: true,
      },
      {
        name: "unavailable native inspection",
        permissions: { ...safe, ok: false, source: "unknown" },
        unverified: true,
      },
      { name: "non-ACL evidence", permissions: { ...safe, source: "posix" }, unverified: true },
      {
        name: "missing owner evidence",
        permissions: { ...safe, ownerTrusted: undefined },
        unverified: true,
      },
      { name: "untrusted owner", permissions: { ...safe, ownerTrusted: false }, unverified: false },
      { name: "group writer", permissions: { ...safe, groupWritable: true }, unverified: false },
      { name: "world writer", permissions: { ...safe, worldWritable: true }, unverified: false },
    ])("reports $name without downstream effects in human and JSON modes", async (testCase) => {
      const f = await setup();
      vi.mocked(inspectPathPermissions).mockResolvedValue({
        ...testCase.permissions,
        error: "synthetic private descriptor diagnostic",
      });
      const message = testCase.unverified ? unverifiedMessage : unsafeMessage;
      await expect(f.run(action, false)).rejects.toThrow("__exit__:1");
      expect(f.error).toHaveBeenCalledExactlyOnceWith(message);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);

      await expect(f.run(action, true)).rejects.toMatchObject({ message });
      // Machine-mode failures propagate to the canonical root cli_error envelope.
      expect(f.error).toHaveBeenCalledTimes(1);
      expect(f.exit).toHaveBeenCalledTimes(1);
      expect(f.json).not.toHaveBeenCalled();
      expect(f.log).not.toHaveBeenCalled();
      expect(inspectPathPermissions).toHaveBeenCalledTimes(2);
      expect(inspectPathPermissions).toHaveBeenCalledWith(await fs.realpath(f.local.bundledDir));
      expect(f.manage).not.toHaveBeenCalled();
      expect(f.windows.ops.identity).not.toHaveBeenCalled();
      expect(boundary.readToken).not.toHaveBeenCalled();
      expect(boundary.ensureToken).not.toHaveBeenCalled();
      expect(boundary.connect).not.toHaveBeenCalled();
      await expect(fs.stat(f.local.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("retains safe source admission and the existing setup JSON result", async () => {
      const f = await setup();
      await f.run(action, true);
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.error).not.toHaveBeenCalled();
      expect(f.log).not.toHaveBeenCalled();
      expect(f.json).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action,
          target: expect.objectContaining({
            kind: "local-host",
            platform: "win32",
            profile: "chrome",
          }),
          connection: { state: action === "verify" ? "unavailable" : "not_checked" },
        }),
      );
      expect(f.manage).toHaveBeenCalledTimes(1);
      expect(f.manage.mock.calls[0]?.[1].action).toBe(action === "install" ? "install" : "inspect");
      expect(boundary.ensureToken).not.toHaveBeenCalled();
      expect(boundary.connect).not.toHaveBeenCalled();
      if (action === "install") {
        await expect(fs.stat(f.local.stateDir)).resolves.toBeDefined();
      } else {
        await expect(fs.stat(f.local.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  },
);
