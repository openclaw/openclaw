// Browser tests cover browser cli.lazy plugin behavior.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserMachineOutput } from "../../cli-output-mode.js";

const manageMocks = vi.hoisted(() => {
  const doctorAction = vi.fn();
  const openAction = vi.fn();
  const startAction = vi.fn();
  const statusAction = vi.fn();
  const tabNewAction = vi.fn();
  const tabsAction = vi.fn();
  const registerBrowserManageCommands = vi.fn((browser: Command) => {
    browser.command("start").description("Start browser").action(startAction);
    browser.command("status").description("Show browser status").action(statusAction);
    browser.command("tabs").description("List tabs").action(tabsAction);
    browser
      .command("tab")
      .description("Tab shortcuts")
      .command("new")
      .description("Open a new tab")
      .action(tabNewAction);
    browser.command("open").description("Open URL").argument("<url>").action(openAction);
    browser
      .command("doctor")
      .description("Check browser plugin readiness")
      .option("--deep", "Run a live snapshot check")
      .action(doctorAction);
  });
  return {
    doctorAction,
    openAction,
    registerBrowserManageCommands,
    startAction,
    statusAction,
    tabNewAction,
    tabsAction,
  };
});
const cookieSyncMocks = vi.hoisted(() => ({
  registerBrowserCookieSyncCommand: vi.fn(),
}));
const inspectMocks = vi.hoisted(() => ({
  registerBrowserInspectCommands: vi.fn(),
}));
const actionInputMocks = vi.hoisted(() => {
  const waitAction = vi.fn();
  const registerBrowserActionInputCommands = vi.fn(
    (browser: Command, parentOpts: (command: Command) => unknown) => {
      browser
        .command("wait")
        .option("--url <pattern>")
        .action((opts, command) => waitAction(opts, parentOpts(command)));
    },
  );
  return { registerBrowserActionInputCommands, waitAction };
});
const actionObserveMocks = vi.hoisted(() => ({
  registerBrowserActionObserveCommands: vi.fn(),
}));
const debugMocks = vi.hoisted(() => ({
  registerBrowserDebugCommands: vi.fn(),
}));
const stateMocks = vi.hoisted(() => {
  const cookieSetAction = vi.fn();
  const registerBrowserStateCommands = vi.fn(
    (browser: Command, parentOpts: (command: Command) => unknown) => {
      browser
        .command("cookies")
        .command("set")
        .argument("<name>")
        .argument("<value>")
        .option("--url <url>")
        .action((name, value, opts, command) =>
          cookieSetAction(name, value, opts, parentOpts(command)),
        );
    },
  );
  return { cookieSetAction, registerBrowserStateCommands };
});
const extensionMocks = vi.hoisted(() => ({
  registerBrowserExtensionCommands: vi.fn(),
}));

vi.mock("./browser-cli-manage.js", () => manageMocks);
vi.mock("./browser-cli-cookie-sync.js", () => cookieSyncMocks);
vi.mock("./browser-cli-inspect.js", () => inspectMocks);
vi.mock("./browser-cli-actions-input/register.js", () => actionInputMocks);
vi.mock("./browser-cli-actions-observe.js", () => actionObserveMocks);
vi.mock("./browser-cli-debug.js", () => debugMocks);
vi.mock("./browser-cli-state.js", () => stateMocks);
vi.mock("./browser-cli-extension.js", () => extensionMocks);

const { registerBrowserCli } = await import("./browser-cli.js");

function requireFirstCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  label: string,
): TArgs {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

function requireTrailingCommand(args: unknown[], label: string): Command {
  const command = args.at(-1);
  if (!(command instanceof Command)) {
    throw new Error(`expected trailing command for ${label}`);
  }
  return command;
}

describe("registerBrowserCli lazy browser subcommands", () => {
  it.each([["session storage", ["browser", "storage", "session", "get", "key"]]])(
    "declares default JSON output for %s",
    (_name, args) => {
      expect(isBrowserMachineOutput({ argv: ["node", "openclaw", ...args] })).toBe(true);
    },
  );

  it.each(["uninstall-host"])("declares explicit JSON output for extension %s", (subcommand) => {
    expect(
      isBrowserMachineOutput({
        argv: ["node", "openclaw", "browser", "extension", subcommand, "--json"],
      }),
    ).toBe(true);
  });

  it("keeps human browser commands out of machine-output mode", () => {
    expect(isBrowserMachineOutput({ argv: ["node", "openclaw", "browser", "status"] })).toBe(false);
    expect(
      isBrowserMachineOutput({ argv: ["node", "openclaw", "browser", "cookies", "set"] }),
    ).toBe(false);
  });

  it("accepts supported root options after browser", () => {
    expect(
      isBrowserMachineOutput({
        argv: ["node", "openclaw", "browser", "--log-level", "debug", "evaluate"],
      }),
    ).toBe(true);
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    manageMocks.registerBrowserManageCommands.mockClear();
    manageMocks.doctorAction.mockClear();
    manageMocks.openAction.mockClear();
    manageMocks.startAction.mockClear();
    manageMocks.statusAction.mockClear();
    manageMocks.tabNewAction.mockClear();
    manageMocks.tabsAction.mockClear();
    cookieSyncMocks.registerBrowserCookieSyncCommand.mockClear();
    inspectMocks.registerBrowserInspectCommands.mockClear();
    actionInputMocks.registerBrowserActionInputCommands.mockClear();
    actionInputMocks.waitAction.mockClear();
    actionObserveMocks.registerBrowserActionObserveCommands.mockClear();
    debugMocks.registerBrowserDebugCommands.mockClear();
    stateMocks.registerBrowserStateCommands.mockClear();
    stateMocks.cookieSetAction.mockClear();
    extensionMocks.registerBrowserExtensionCommands.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads browser doctor from the manage group so --deep is available", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "doctor", "--deep"]);

    await program.parseAsync(["browser", "doctor", "--deep"], { from: "user" });

    expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
    expect(debugMocks.registerBrowserDebugCommands).not.toHaveBeenCalled();
    expect(manageMocks.doctorAction).toHaveBeenCalledTimes(1);
    const [doctorOptions] = requireFirstCall(manageMocks.doctorAction, "doctor action call");
    expect(doctorOptions.deep).toBe(true);
  });

  it("keeps explicit Gateway and wait URLs under their separate owners", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "--url",
      "ws://127.0.0.1:18789",
      "wait",
      "--url",
      "**/done",
    ]);

    await program.parseAsync(
      ["browser", "--url", "ws://127.0.0.1:18789", "wait", "--url", "**/done"],
      { from: "user" },
    );

    const [opts, parent] = requireFirstCall(actionInputMocks.waitAction, "wait action call");
    expect(opts).toMatchObject({ url: "**/done" });
    expect(parent).toMatchObject({ url: "ws://127.0.0.1:18789" });
  });

  it("accepts the shipped trailing browser profile order after lazy loading", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "tabs",
      "--browser-profile",
      "remote",
      "--timeout",
      "60000",
    ]);

    await program.parseAsync(
      ["browser", "tabs", "--browser-profile", "remote", "--timeout", "60000"],
      {
        from: "user",
      },
    );

    const tabsCommand = requireTrailingCommand(
      requireFirstCall(manageMocks.tabsAction, "tabs action call"),
      "tabs action",
    );
    expect(tabsCommand.parent?.opts().browserProfile).toBe("remote");
    expect(tabsCommand.parent?.opts().timeout).toBe("60000");
  });

  it("preserves parent timeout before a nested lazily loaded storage-family leaf", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    const args = [
      "browser",
      "--timeout",
      "60000",
      "--browser-profile",
      "work",
      "--json",
      "cookies",
      "set",
      "session",
      "abc",
    ];
    registerBrowserCli(program, ["node", "openclaw", ...args]);

    await program.parseAsync(args, { from: "user" });

    const cookieCall = requireFirstCall(stateMocks.cookieSetAction, "cookie set action call");
    expect(cookieCall[3]).toMatchObject({ timeout: "60000", browserProfile: "work", json: true });
  });

  it("can eagerly register all browser groups for compatibility", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", "1");
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);

    await vi.waitFor(() => {
      expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
      expect(cookieSyncMocks.registerBrowserCookieSyncCommand).toHaveBeenCalledTimes(1);
      expect(inspectMocks.registerBrowserInspectCommands).toHaveBeenCalledTimes(1);
      expect(actionInputMocks.registerBrowserActionInputCommands).toHaveBeenCalledTimes(1);
      expect(actionObserveMocks.registerBrowserActionObserveCommands).toHaveBeenCalledTimes(1);
      expect(debugMocks.registerBrowserDebugCommands).toHaveBeenCalledTimes(1);
      expect(stateMocks.registerBrowserStateCommands).toHaveBeenCalledTimes(1);
      expect(extensionMocks.registerBrowserExtensionCommands).toHaveBeenCalledTimes(1);
    });
  });
});
