import "../browser/extension-install-fixture.test-support.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallFixture } from "../browser/extension-install-fixture.test-support.js";
import { useExtensionInstallFixture } from "../browser/extension-install.test-support.js";
import type {
  WindowsManagementRequest,
  WindowsManagementResponse,
} from "../browser/extension-windows-contract.js";
import { windowsFixture } from "../browser/extension-windows.test-support.js";
import {
  createBrowserCliCapture,
  runExtensionSetup,
} from "./browser-cli-extension.test-support.js";

const boundary = vi.hoisted(() => ({
  deps: undefined as InstallFixture | undefined,
  connect: vi.fn(),
  readToken: vi.fn(),
  config: vi.fn<() => OpenClawConfig>(),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => boundary.config(),
}));
// Keep the actual CLI, controller, installer, adapter and metadata validator.
// Only inject isolated filesystem/Windows OS facts and the C# process boundary.
vi.mock("../browser/extension-install.js", async (original) => {
  const real = await original<typeof import("../browser/extension-install.js")>();
  const fixture = await import("../browser/extension-install-fixture.test-support.js");
  return {
    ...real,
    browserExtensionStatus: (p: Parameters<typeof real.browserExtensionStatus>[0]) =>
      fixture.browserExtensionStatus({ ...p, deps: boundary.deps }),
    installChromeExtensionBootstrap: (
      p: Parameters<typeof real.installChromeExtensionBootstrap>[0],
    ) => fixture.installChromeExtensionBootstrap({ ...p, deps: boundary.deps }),
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
const { installRuntime, resetRuntimeCapture } = createBrowserCliCapture();
type Setup = Awaited<ReturnType<typeof setup>>;
async function expectInstallBlocked(f: Setup) {
  await expect(f.run("install")).rejects.toThrow("__exit__:1");
  expect(f.mutations()).toHaveLength(0);
}
function expectJson(f: Setup, shape: Record<string, unknown>) {
  expect(f.json).toHaveBeenCalledWith(expect.objectContaining(shape));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  boundary.deps = undefined;
  resetRuntimeCapture();
});

async function setup() {
  const local = await localFixture("win32");
  const f = windowsFixture();
  const state: {
    active?: string;
    response?: WindowsManagementResponse;
    before?: (request: WindowsManagementRequest) => void;
  } = {};
  const manage = vi.fn(
    async (
      _exe: string,
      request: WindowsManagementRequest,
      _options: { signal?: AbortSignal } = {},
    ) => {
      state.before?.(request);
      if (state.response) {
        return state.response;
      }
      if (state.active && request.context?.browserProfile !== state.active) {
        return {
          ...f.response,
          ok: false,
          code: "context_conflict",
          installation: null,
        } satisfies WindowsManagementResponse;
      }
      if (request.action === "install") {
        state.active = request.context!.browserProfile;
        f.prepare(request.context!, request.expectedOrigins);
      }
      return state.active
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
  const real = await import("../browser/extension-install-fixture.test-support.js");
  await real.installChromeExtensionBootstrap({
    ...local,
    deps: boundary.deps,
    browserProfile: "work",
  });
  manage.mockClear();
  const cfg = boundary.config.mockReset().mockReturnValue({
    browser: { profiles: { work: { driver: "extension", cdpPort: 19444 } } },
  });
  const { json, error, exit } = installRuntime();
  boundary.readToken.mockReturnValue("synthetic-relay-token");
  boundary.connect.mockResolvedValue({
    status: async () => ({ ready: true, identity: { extensionVersion: "fixture" } }),
    close: async () => {},
  });
  const run = (action: string, profile?: string) =>
    runExtensionSetup(local.pluginRoot, action, profile);
  return {
    ...f,
    local,
    manage,
    cfg,
    json,
    error,
    exit,
    run,
    state,
    mutations: () => manage.mock.calls.filter(([, r]) => r.action !== "inspect"),
  };
}

describe("Windows saved selection through the registered setup CLI", () => {
  it.each(["verify", "install"])("recovers current work for selector-free %s", async (action) => {
    const f = await setup();
    await f.run(action);
    expect(f.exit).not.toHaveBeenCalled();
    expectJson(f, { target: expect.objectContaining({ profile: "work", relayPort: 19444 }) });
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
  });
  it("refuses an explicit different context without discovering or retrying another profile", async () => {
    const f = await setup();
    await f.run("verify", "chrome");
    expect(f.mutations()).toHaveLength(0);
    expect(boundary.readToken).not.toHaveBeenCalled();
    expectJson(f, { phase: "blocked" });
    expect(f.manage).toHaveBeenCalledTimes(1);
  });
  it.each(["absent-profile", "companion", "foreign-store"])(
    "blocks %s with no mutation",
    async (kind) => {
      const f = await setup();
      if (kind === "absent-profile") {
        f.cfg.mockReturnValue({});
      }
      if (kind === "foreign-store") {
        f.state.response = {
          ...f.response,
          ok: false,
          code: "foreign_registration",
          store: "foreign",
          installation: null,
        };
      }
      if (kind === "companion") {
        f.state.response = {
          ...f.response,
          ok: false,
          code: "context_conflict",
          mode: "companion-managed-wsl",
          installation: null,
        };
      }
      await expectInstallBlocked(f);
      expect(f.exit).toHaveBeenCalledWith(1);
      expect(boundary.readToken).not.toHaveBeenCalled();
    },
  );
  it("still verifies an existing relay when the native registration is genuinely missing", async () => {
    const f = await setup();
    f.state.active = undefined;
    await f.run("verify");
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.mutations()).toHaveLength(0);
    expectJson(f, {
      phase: "ready",
      connection: { state: "connected", extensionVersion: "fixture" },
      installation: expect.objectContaining({ nativeHostRegistered: false }),
    });
  });
  it("blocks a changed observation before mutation", async () => {
    const f = await setup();
    let workReads = 0;
    f.state.before = (r) => {
      if (r.action === "inspect" && r.context?.browserProfile === "work" && ++workReads === 2) {
        f.state.active = "chrome";
      }
    };
    await expectInstallBlocked(f);
    expect(f.exit).toHaveBeenCalledWith(1);
  });
  it("rejects a descriptor with a changed state directory", async () => {
    const f = await setup();
    f.context.stateDir = f.context.stateDir.replace("C:", "D:");
    await expectInstallBlocked(f);
  });
  it("rejects coherent metadata with a different approved-origin set", async () => {
    const f = await setup();
    f.prepare({ ...f.context, browserProfile: "work" });
    await expectInstallBlocked(f);
  });
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
    f.state.before = (r) => {
      if (r.context?.browserProfile === "beta") {
        budget.abort();
      }
    };
    await expectInstallBlocked(f);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(f.manage.mock.calls.map(([, r]) => r.context?.browserProfile)).toEqual([
      "chrome",
      "alpha",
      "beta",
    ]);
    expect(f.manage.mock.calls.slice(1).every((call) => call[2]?.signal === budget.signal)).toBe(
      true,
    );
    expect(boundary.readToken).not.toHaveBeenCalled();
  });
  it("never retries after an uncertain started mutation", async () => {
    const f = await setup();
    f.state.before = (r) => {
      if (r.action === "install") {
        throw new Error("synthetic unknown outcome");
      }
    };
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(f.mutations()).toHaveLength(1);
    expect(f.manage.mock.calls.at(-1)?.[1].action).toBe("install");
    expect(JSON.stringify(f.error.mock.calls)).not.toContain("synthetic unknown outcome");
  });
  it("leaves the final race to the serialized C# mutation guard without retry", async () => {
    const f = await setup();
    f.state.before = (r) => {
      if (r.action === "install") {
        f.state.active = "chrome";
      }
    };
    await f.run("install");
    expect(f.mutations()).toHaveLength(1);
    expect(f.mutations()[0]?.[1].context?.browserProfile).toBe("work");
    expectJson(f, { phase: "blocked" });
  });
});
