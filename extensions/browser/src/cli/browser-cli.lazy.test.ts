import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserMachineOutput } from "../../cli-output-mode.js";

const manageMocks = vi.hoisted(() => {
  const doctorAction = vi.fn<(opts: { deep?: boolean }) => void>();
  const tabsAction = vi.fn<(...args: unknown[]) => void>();
  const registerBrowserManageCommands = vi.fn((browser: Command) => {
    browser.command("tabs").action(tabsAction);
    browser.command("doctor").option("--deep").action(doctorAction);
  });
  return {
    doctorAction,
    registerBrowserManageCommands,
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
  const waitAction = vi.fn<(opts: unknown, parent: unknown) => void>();
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
  const cookieSetAction =
    vi.fn<(name: string, value: string, opts: unknown, parent: unknown) => void>();
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
const machineOutput = (...args: string[]) =>
  isBrowserMachineOutput({ argv: ["node", "openclaw", "browser", ...args] });

async function run(args: string[], positionalOptions = true) {
  const program = new Command().name("openclaw");
  if (positionalOptions) {
    program.enablePositionalOptions();
  }
  registerBrowserCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
}

describe("registerBrowserCli lazy browser subcommands", () => {
  it.each([
    { args: ["storage", "session", "get", "key"], machine: true },
    { args: ["extension", "uninstall-host", "--json"], machine: true },
    { args: ["status"], machine: false },
    { args: ["cookies", "set"], machine: false },
    { args: ["--log-level", "debug", "evaluate"], machine: true },
  ])("detects machine=$machine output for $args", ({ args, machine }) => {
    expect(machineOutput(...args)).toBe(machine);
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads browser doctor from the manage group so --deep is available", async () => {
    await run(["browser", "doctor", "--deep"], false);

    expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
    expect(debugMocks.registerBrowserDebugCommands).not.toHaveBeenCalled();
    expect(manageMocks.doctorAction).toHaveBeenCalledTimes(1);
    expect(manageMocks.doctorAction.mock.calls[0]?.[0]).toMatchObject({ deep: true });
  });

  it("keeps explicit Gateway and wait URLs under their separate owners", async () => {
    await run(["browser", "--url", "ws://127.0.0.1:18789", "wait", "--url", "**/done"]);

    const [opts, parent] = actionInputMocks.waitAction.mock.calls[0]!;
    expect(opts).toMatchObject({ url: "**/done" });
    expect(parent).toMatchObject({ url: "ws://127.0.0.1:18789" });
  });

  it("accepts the shipped trailing browser profile order after lazy loading", async () => {
    await run(["browser", "tabs", "--browser-profile", "remote", "--timeout", "60000"]);

    const tabsCommand = manageMocks.tabsAction.mock.calls[0]?.at(-1);
    if (!(tabsCommand instanceof Command)) {
      throw new Error("expected trailing tabs command");
    }
    expect(tabsCommand.parent?.opts()).toMatchObject({
      browserProfile: "remote",
      timeout: "60000",
    });
  });

  it("preserves parent timeout before a nested lazily loaded storage-family leaf", async () => {
    await run([
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
    ]);

    const cookieCall = stateMocks.cookieSetAction.mock.calls[0]!;
    expect(cookieCall[3]).toMatchObject({ timeout: "60000", browserProfile: "work", json: true });
  });

  it("can eagerly register all browser groups for compatibility", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", "1");
    const program = new Command().name("openclaw");

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
