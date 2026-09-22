import { describe, expect, it, vi } from "vitest";
import { installChromeExtensionBootstrap } from "./extension-install.js";
import { useExtensionInstallFixture } from "./extension-install.test-support.js";
import {
  WINDOWS_OFFICIAL_ORIGIN,
  type WindowsManagementRequest,
  type WindowsManagementResponse,
} from "./extension-windows-contract.js";
import {
  inspectWindowsNativeHosts,
  installWindowsNativeHost,
  uninstallWindowsNativeHosts,
  validateWindowsNativeContext,
} from "./extension-windows-host.js";
import { windowsFixture } from "./extension-windows.test-support.js";
const localFixture = useExtensionInstallFixture();
describe("delegated Windows registration and read-only native admission", () => {
  function setup() {
    const f = windowsFixture();
    const manage = vi.fn(
      async (
        _exe: string,
        request: WindowsManagementRequest,
      ): Promise<WindowsManagementResponse> => {
        if (!request.context) {
          throw new Error("Explicit native context required");
        }
        f.prepare(request.context, request.expectedOrigins);
        return request.action === "uninstall"
          ? { ...f.response, registration: "missing" as const, mode: null, installation: null }
          : f.response;
      },
    );
    const deps = {
      platform: "win32" as const,
      windowsNative: { platform: f.ops, context: f.context, executable: f.executable, manage },
    };
    return { ...f, manage, deps };
  }
  it("delegates real controller install once, explicitly native, and never exposes private management paths", async () => {
    const f = setup();
    const local = await localFixture("linux");
    const result = await installChromeExtensionBootstrap({
      bundledDir: local.bundledDir,
      pluginRoot: local.pluginRoot,
      deps: { ...local.deps, ...f.deps },
      nativeHostExecutable: f.executable,
    });
    expect(f.manage).toHaveBeenCalledTimes(1);
    expect(f.manage.mock.calls[0]?.[1]).toMatchObject({
      action: "install",
      mode: "native-windows-cli",
      context: f.context,
      store: "preserve",
    });
    expect(result.registrations.map((r) => r.state)).toEqual(["owned", "owned", "owned"]);
    expect(JSON.stringify(result)).not.toContain(f.identity.localAppData);
  });
  it("retains a partial Store refusal as owned registration, never all-or-nothing success", async () => {
    const f = setup();
    f.manage.mockResolvedValue({ ...f.response, ok: false, code: "browser_control_disabled" });
    const result = await installWindowsNativeHost({
      pluginRoot: "C:\\OpenClaw",
      extensionIds: [],
      deps: f.deps,
      requestStoreInstall: true,
    });
    expect(result.registrations.every((r) => r.state === "owned")).toBe(true);
    expect(result.storeInstallRequests[0]?.state).toBe("missing");
    expect(result.issues).toEqual(["Windows management reported browser_control_disabled"]);
  });
  it("keeps unreadable observation null instead of inventing missing/invalid", async () => {
    const f = setup();
    f.manage.mockRejectedValue(new Error("private diagnostic"));
    const result = await inspectWindowsNativeHosts({ deps: f.deps });
    expect(result.registrations.every((r) => r.state === null)).toBe(true);
    expect(result.storeInstallRequests[0]?.state).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
    expect(f.manage).toHaveBeenCalledTimes(1);
  });
  it("does not retry or inspect automatically after an uncertain mutation", async () => {
    const f = setup();
    f.manage.mockRejectedValue(new Error("uncertain"));
    await expect(
      installWindowsNativeHost({ pluginRoot: "C:\\OpenClaw", extensionIds: [], deps: f.deps }),
    ).rejects.toThrow();
    expect(f.manage).toHaveBeenCalledTimes(1);
  });
  it("delegates uninstall/remove only to the same explicit context", async () => {
    const f = setup();
    const result = await uninstallWindowsNativeHosts({ deps: f.deps, removeStore: true });
    expect(result.refused).toEqual([]);
    expect(f.manage.mock.calls[0]?.[1]).toMatchObject({
      action: "uninstall",
      store: "remove",
      context: f.context,
    });
  });
  it("validates the fixed root, profile and runtime without any management/config/key operation", async () => {
    const f = setup();
    f.context.browserProfile = "work";
    f.prepare();
    expect(
      await validateWindowsNativeContext(
        {
          manifestPath: f.installation.manifestPath,
          launcherPath: f.installation.launcherPath,
          expectedOrigins: [WINDOWS_OFFICIAL_ORIGIN],
        },
        f.deps,
      ),
    ).toBe("work");
    expect(f.manage).not.toHaveBeenCalled();
    expect(f.ops.readFile).not.toHaveBeenCalledWith(f.context.configPath, expect.anything());
  });
  it.each([
    "companion",
    "hash",
    "foreign-sid",
    "extra-file",
    "runtime-acl",
    "context",
    "state-root",
  ])("rejects %s before credential work", async (kind) => {
    const f = setup();
    let manifestPath = f.installation.manifestPath;
    if (kind === "companion") {
      f.prepare(f.context, [WINDOWS_OFFICIAL_ORIGIN], true);
    }
    if (kind === "hash") {
      f.files.set(f.installation.bindingPath, Buffer.from("{}"));
    }
    if (kind === "foreign-sid") {
      vi.mocked(f.ops.identity).mockResolvedValue({
        ...f.identity,
        sid: "S-1-5-21-111-222-333-1002",
      });
    }
    if (kind === "extra-file") {
      vi.mocked(f.ops.listFiles).mockResolvedValue(["foreign"]);
    }
    if (kind === "runtime-acl") {
      vi.mocked(f.ops.assertPath).mockImplementation(async (target) => {
        if (target === f.context.nodePath) {
          throw new Error("unsafe");
        }
      });
    }
    if (kind === "context") {
      f.deps.windowsNative.context = { ...f.context, configPath: "C:\\other.json" };
    }
    if (kind === "state-root") {
      manifestPath =
        f.context.stateDir +
        "\\browser\\native-messaging\\windows\\" +
        f.installation.generation +
        "\\ai.openclaw.browser_bootstrap.json";
    }
    await expect(
      validateWindowsNativeContext(
        {
          manifestPath,
          launcherPath: f.installation.launcherPath,
          expectedOrigins: [WINDOWS_OFFICIAL_ORIGIN],
        },
        f.deps,
      ),
    ).rejects.toThrow();
    expect(f.manage).not.toHaveBeenCalled();
  });
});
