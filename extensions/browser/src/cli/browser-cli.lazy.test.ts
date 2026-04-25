import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const manageMocks = vi.hoisted(() => {
  const statusAction = vi.fn();
  const registerBrowserManageCommands = vi.fn((browser: Command) => {
    browser.command("status").description("Show browser status").action(statusAction);
  });
  return { registerBrowserManageCommands, statusAction };
});
const inspectMocks = vi.hoisted(() => ({
  registerBrowserInspectCommands: vi.fn(),
}));
const actionInputMocks = vi.hoisted(() => ({
  registerBrowserActionInputCommands: vi.fn(),
}));
const actionObserveMocks = vi.hoisted(() => ({
  registerBrowserActionObserveCommands: vi.fn(),
}));
const debugMocks = vi.hoisted(() => ({
  registerBrowserDebugCommands: vi.fn(),
}));
const stateMocks = vi.hoisted(() => ({
  registerBrowserStateCommands: vi.fn(),
}));

vi.mock("./browser-cli-manage.js", () => manageMocks);
vi.mock("./browser-cli-inspect.js", () => inspectMocks);
vi.mock("./browser-cli-actions-input.js", () => actionInputMocks);
vi.mock("./browser-cli-actions-observe.js", () => actionObserveMocks);
vi.mock("./browser-cli-debug.js", () => debugMocks);
vi.mock("./browser-cli-state.js", () => stateMocks);

const { registerBrowserCli } = await import("./browser-cli.js");

describe("registerBrowserCli lazy browser subcommands", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    manageMocks.registerBrowserManageCommands.mockClear();
    manageMocks.statusAction.mockClear();
    inspectMocks.registerBrowserInspectCommands.mockClear();
    actionInputMocks.registerBrowserActionInputCommands.mockClear();
    actionObserveMocks.registerBrowserActionObserveCommands.mockClear();
    debugMocks.registerBrowserDebugCommands.mockClear();
    stateMocks.registerBrowserStateCommands.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers browser placeholders without loading handlers for help", () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);

    const browser = program.commands.find((command) => command.name() === "browser");
    expect(browser?.commands.map((command) => command.name())).toContain("status");
    expect(browser?.commands.map((command) => command.name())).toContain("snapshot");
    expect(browser?.commands.map((command) => command.name())).toContain("doctor");
    expect(manageMocks.registerBrowserManageCommands).not.toHaveBeenCalled();
    expect(inspectMocks.registerBrowserInspectCommands).not.toHaveBeenCalled();
    expect(actionInputMocks.registerBrowserActionInputCommands).not.toHaveBeenCalled();
  });

  it("registers only the requested browser group before dispatch", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "status"]);

    const browser = program.commands.find((command) => command.name() === "browser");
    expect(browser?.commands.map((command) => command.name())).toEqual(["status"]);

    await program.parseAsync(["browser", "status"], { from: "user" });

    expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
    expect(inspectMocks.registerBrowserInspectCommands).not.toHaveBeenCalled();
    expect(manageMocks.statusAction).toHaveBeenCalledTimes(1);
  });

  it("can eagerly register all browser groups for compatibility", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", "1");
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);

    await vi.waitFor(() =>
      expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1),
    );
    expect(inspectMocks.registerBrowserInspectCommands).toHaveBeenCalledTimes(1);
    expect(actionInputMocks.registerBrowserActionInputCommands).toHaveBeenCalledTimes(1);
    expect(actionObserveMocks.registerBrowserActionObserveCommands).toHaveBeenCalledTimes(1);
    expect(debugMocks.registerBrowserDebugCommands).toHaveBeenCalledTimes(1);
    expect(stateMocks.registerBrowserStateCommands).toHaveBeenCalledTimes(1);
  });
});
