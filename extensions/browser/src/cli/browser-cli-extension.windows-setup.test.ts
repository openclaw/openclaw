import { Command } from "commander";
import * as runtimeConfigSnapshot from "openclaw/plugin-sdk/runtime-config-snapshot";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import type { ExtensionInstallDeps } from "../browser/extension-install-layout.js";
import { useExtensionInstallFixture } from "../browser/extension-install.test-support.js";
import type {
  WindowsManagementRequest,
  WindowsManagementResponse,
} from "../browser/extension-windows-contract.js";
import { windowsFixture } from "../browser/extension-windows.test-support.js";

const boundary = vi.hoisted(() => ({
  deps: undefined as ExtensionInstallDeps | undefined,
  connect: vi.fn(),
  readToken: vi.fn(),
}));
// Keep the actual CLI, controller, installer, adapter and metadata validator.
// Only inject isolated filesystem/Windows OS facts and the C# process boundary.
vi.mock("../browser/extension-install.js", async (original) => {
  const real = await original<typeof import("../browser/extension-install.js")>();
  return {
    ...real,
    browserExtensionStatus: (p: Parameters<typeof real.browserExtensionStatus>[0]) =>
      real.browserExtensionStatus({ ...p, deps: boundary.deps }),
    installChromeExtensionBootstrap: (
      p: Parameters<typeof real.installChromeExtensionBootstrap>[0],
    ) => real.installChromeExtensionBootstrap({ ...p, deps: boundary.deps }),
  };
});
vi.mock("../browser/extension-relay/relay-auth.js", () => ({
  readExtensionRelayToken: boundary.readToken,
  ensureExtensionRelayToken: vi.fn(),
}));
vi.mock("../browser/extension-relay/owner-client.js", () => ({
  RelayOwnerClient: { connect: boundary.connect },
}));
const localFixture = useExtensionInstallFixture();
const { defaultRuntime: capture, resetRuntimeCapture } = createCliRuntimeCapture();
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  boundary.deps = undefined;
  resetRuntimeCapture();
});

async function setup() {
  const local = await localFixture("win32");
  const f = windowsFixture();
  let active: string | undefined;
  let override: WindowsManagementResponse | undefined;
  let before: ((request: WindowsManagementRequest) => void) | undefined;
  const manage = vi.fn(
    async (
      _exe: string,
      request: WindowsManagementRequest,
      _options: { signal?: AbortSignal } = {},
    ) => {
      before?.(request);
      if (override) {
        return override;
      }
      if (active && request.context?.browserProfile !== active) {
        return {
          ...f.response,
          ok: false,
          code: "context_conflict",
          installation: null,
        } satisfies WindowsManagementResponse;
      }
      if (request.action === "install") {
        active = request.context!.browserProfile;
        f.prepare(request.context!, request.expectedOrigins);
      }
      return active
        ? f.response
        : ({
            ...f.response,
            registration: "missing",
            mode: null,
            installation: null,
          } satisfies WindowsManagementResponse);
    },
  );
  boundary.deps = {
    ...local.deps,
    windowsNative: { platform: f.ops, context: f.context, executable: f.executable, manage },
  };
  const real = await vi.importActual<typeof import("../browser/extension-install.js")>(
    "../browser/extension-install.js",
  );
  await real.installChromeExtensionBootstrap({
    ...local,
    deps: boundary.deps,
    browserProfile: "work",
  });
  manage.mockClear();
  const cfg = vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue({
    browser: { profiles: { work: { driver: "extension", cdpPort: 19444 } } },
  });
  const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(capture.writeJson);
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(capture.error);
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(capture.exit);
  boundary.readToken.mockReturnValue("synthetic-relay-token");
  boundary.connect.mockResolvedValue({
    status: async () => ({ ready: true, identity: { extensionVersion: "fixture" } }),
    close: async () => {},
  });
  const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
  async function run(action: string, profile?: string) {
    const program = new Command();
    registerBrowserExtensionCommands(program.command("browser"), () => ({}), local.pluginRoot);
    await program.parseAsync(
      [
        "browser",
        "extension",
        "setup",
        "--action",
        action,
        "--json",
        ...(profile ? ["--browser-profile", profile] : []),
      ],
      { from: "user" },
    );
  }
  return {
    ...f,
    local,
    manage,
    cfg,
    json,
    error,
    exit,
    run,
    setActive: (value: string | undefined) => {
      active = value;
    },
    setResponse: (value: WindowsManagementResponse) => {
      override = value;
    },
    before: (fn: (request: WindowsManagementRequest) => void) => {
      before = fn;
    },
    mutations: () => manage.mock.calls.filter(([, r]) => r.action !== "inspect"),
  };
}

describe("Windows saved selection through the registered setup CLI", () => {
  it.each(["inspect", "verify", "install"])(
    "recovers current work for selector-free %s",
    async (action) => {
      const f = await setup();
      await f.run(action);
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.json).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ profile: "work", relayPort: 19444 }),
        }),
      );
      expect(f.mutations()).toHaveLength(action === "install" ? 1 : 0);
      expect(f.manage.mock.calls.map(([, r]) => [r.action, r.context?.browserProfile])).toEqual([
        ["inspect", "chrome"],
        ["inspect", "work"],
        ["inspect", "work"],
        ...(action === "install" ? [["install", "work"]] : []),
      ]);
      if (action === "verify") {
        expect(boundary.connect).toHaveBeenCalledWith(
          expect.objectContaining({ profile: "work", port: 19444 }),
        );
      } else {
        expect(boundary.readToken).not.toHaveBeenCalled();
      }
      expect(JSON.stringify(f.json.mock.calls)).not.toContain(f.identity.localAppData);
    },
  );
  it("does not let retained work metadata override the current chrome registration", async () => {
    const f = await setup();
    f.setActive("chrome");
    // The former work metadata exists but cannot validate the owner's current descriptor/context.
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(f.mutations()).toHaveLength(0);
    expect(f.exit).toHaveBeenCalledWith(1);
  });
  it("refuses an explicit different context without discovering or retrying another profile", async () => {
    const f = await setup();
    await f.run("verify", "chrome");
    expect(f.mutations()).toHaveLength(0);
    expect(boundary.readToken).not.toHaveBeenCalled();
    expect(f.json).toHaveBeenCalledWith(expect.objectContaining({ phase: "blocked" }));
    expect(f.manage).toHaveBeenCalledTimes(1);
  });
  it.each([
    "absent-profile",
    "drift",
    "no-descriptor",
    "unknown",
    "foreign",
    "mixed",
    "companion",
    "foreign-store",
  ])("blocks %s with no mutation", async (kind) => {
    const f = await setup();
    if (kind === "absent-profile") {
      f.cfg.mockReturnValue({});
    }
    if (kind === "no-descriptor") {
      f.setResponse({ ...f.response, installation: null });
    }
    if (kind === "foreign-store") {
      f.setResponse({
        ...f.response,
        ok: false,
        code: "foreign_registration",
        store: "foreign",
        installation: null,
      });
    }
    if (kind === "drift") {
      f.setResponse({ ...f.response, ok: false, code: "binding_invalid", installation: null });
    }
    if (kind === "unknown") {
      f.setResponse({
        v: 1,
        ok: false,
        code: "io_error",
        registration: null,
        mode: null,
        store: null,
        installation: null,
      });
    }
    if (kind === "foreign" || kind === "mixed") {
      f.setResponse({
        ...f.response,
        ok: false,
        code: kind === "foreign" ? "foreign_registration" : "binding_invalid",
        registration: kind === "foreign" ? "foreign" : "invalid",
        mode: null,
        installation: null,
      });
    }
    if (kind === "companion") {
      f.setResponse({
        ...f.response,
        ok: false,
        code: "context_conflict",
        mode: "companion-managed-wsl",
        installation: null,
      });
    }
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(f.mutations()).toHaveLength(0);
    expect(f.exit).toHaveBeenCalledWith(1);
    expect(boundary.readToken).not.toHaveBeenCalled();
  });
  it("allows the existing default only for confirmed fresh missing registration", async () => {
    const f = await setup();
    f.setActive(undefined);
    await f.run("install");
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.mutations()).toHaveLength(1);
    expect(f.mutations()[0]?.[1].context?.browserProfile).toBe("chrome");
  });
  it("still verifies an existing relay when the native registration is genuinely missing", async () => {
    const f = await setup();
    f.setActive(undefined);
    await f.run("verify");
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.mutations()).toHaveLength(0);
    expect(f.json).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "ready",
        connection: { state: "connected", extensionVersion: "fixture" },
        installation: expect.objectContaining({ nativeHostRegistered: false }),
      }),
    );
  });
  it("blocks a changed observation before mutation", async () => {
    const f = await setup();
    let workReads = 0;
    f.before((r) => {
      if (r.action === "inspect" && r.context?.browserProfile === "work" && ++workReads === 2) {
        f.setActive("chrome");
      }
    });
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(f.exit).toHaveBeenCalledWith(1);
    expect(f.mutations()).toHaveLength(0);
  });
  it.each(["stateDir", "configPath", "nodePath", "cliPath"] as const)(
    "rejects a descriptor with changed %s",
    async (field) => {
      const f = await setup();
      f.context[field] = f.context[field].replace("C:", "D:");
      await expect(f.run("install")).rejects.toThrow("__exit__:1");
      expect(f.mutations()).toHaveLength(0);
    },
  );
  it("rejects coherent metadata with a different approved-origin set", async () => {
    const f = await setup();
    f.prepare({ ...f.context, browserProfile: "work" });
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(f.mutations()).toHaveLength(0);
  });
  it.each(["initial", "candidate", "confirmation"] as const)(
    "cancels at %s without mutation",
    async (phase) => {
      const f = await setup();
      const budget = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
      let reads = 0;
      f.before(() => {
        if (++reads === { initial: 1, candidate: 2, confirmation: 3 }[phase]) {
          budget.abort();
        }
      });
      await expect(f.run("install")).rejects.toThrow("__exit__:1");
      expect(f.mutations()).toHaveLength(0);
      expect(boundary.readToken).not.toHaveBeenCalled();
    },
  );
  it("shares one finite budget across serial candidates and stops on expiry", async () => {
    const f = await setup();
    const budget = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
    f.cfg.mockReturnValue({
      browser: {
        profiles: {
          alpha: { driver: "extension", cdpPort: 19441 },
          beta: { driver: "extension", cdpPort: 19442 },
          gamma: { driver: "extension", cdpPort: 19443 },
          work: { driver: "extension", cdpPort: 19444 },
        },
      },
    });
    f.before((r) => {
      if (r.context?.browserProfile === "beta") {
        budget.abort();
      }
    });
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(f.manage.mock.calls.map(([, r]) => r.context?.browserProfile)).toEqual([
      "chrome",
      "alpha",
      "beta",
    ]);
    expect(f.manage.mock.calls.slice(1).every((call) => call[2]?.signal === budget.signal)).toBe(
      true,
    );
    expect(f.mutations()).toHaveLength(0);
  });
  it("retains explicit same-profile repair for changed runtime inputs", async () => {
    const f = await setup();
    f.context.nodePath = f.context.nodePath.replace("C:", "D:");
    await f.run("install", "work");
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.manage).toHaveBeenCalledTimes(1);
    expect(f.mutations()).toHaveLength(1);
    expect(f.json).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ profile: "work", relayPort: 19444 }),
      }),
    );
  });
  it("never queries invalid names or non-extension configured profiles", async () => {
    const f = await setup();
    f.cfg.mockReturnValue({
      browser: {
        profiles: {
          BAD: { driver: "extension", cdpPort: 19441 },
          managed: { driver: "openclaw", cdpPort: 19442 },
          work: { driver: "extension", cdpPort: 19444 },
        },
      },
    });
    await f.run("inspect");
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.manage.mock.calls.map(([, r]) => r.context?.browserProfile)).toEqual([
      "chrome",
      "work",
      "work",
    ]);
  });
  it("never retries after an uncertain started mutation", async () => {
    const f = await setup();
    f.before((r) => {
      if (r.action === "install") {
        throw new Error("synthetic unknown outcome");
      }
    });
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(f.mutations()).toHaveLength(1);
    expect(f.manage.mock.calls.at(-1)?.[1].action).toBe("install");
    expect(JSON.stringify(f.error.mock.calls)).not.toContain("synthetic unknown outcome");
  });
  it("leaves the final race to the serialized C# mutation guard without retry", async () => {
    const f = await setup();
    f.before((r) => {
      if (r.action === "install") {
        f.setActive("chrome");
      }
    });
    await f.run("install");
    expect(f.mutations()).toHaveLength(1);
    expect(f.mutations()[0]?.[1].context?.browserProfile).toBe("work");
    expect(f.json).toHaveBeenCalledWith(expect.objectContaining({ phase: "blocked" }));
  });
});
