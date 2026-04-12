import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { manageAction, registerBrowserManageCommands } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((browser: Command) => {
    browser.command("status").description("Show browser status").action(action);
  });
  return { manageAction: action, registerBrowserManageCommands: register };
});

const { registerBrowserInspectCommands } = vi.hoisted(() => ({
  registerBrowserInspectCommands: vi.fn(),
}));
const { registerBrowserActionInputCommands } = vi.hoisted(() => ({
  registerBrowserActionInputCommands: vi.fn(),
}));
const { registerBrowserActionObserveCommands } = vi.hoisted(() => ({
  registerBrowserActionObserveCommands: vi.fn(),
}));
const { registerBrowserDebugCommands } = vi.hoisted(() => ({
  registerBrowserDebugCommands: vi.fn(),
}));
const { registerBrowserStateCommands } = vi.hoisted(() => ({
  registerBrowserStateCommands: vi.fn(),
}));

vi.mock("./browser-cli-manage.js", () => ({ registerBrowserManageCommands }));
vi.mock("./browser-cli-inspect.js", () => ({ registerBrowserInspectCommands }));
vi.mock("./browser-cli-actions-input.js", () => ({ registerBrowserActionInputCommands }));
vi.mock("./browser-cli-actions-observe.js", () => ({ registerBrowserActionObserveCommands }));
vi.mock("./browser-cli-debug.js", () => ({ registerBrowserDebugCommands }));
vi.mock("./browser-cli-state.js", () => ({ registerBrowserStateCommands }));

const { registerBrowserCli } = await import("./browser-cli.js");

describe("registerBrowserCli lazy browser subcommands", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    registerBrowserManageCommands.mockClear();
    manageAction.mockClear();
    registerBrowserInspectCommands.mockClear();
    registerBrowserActionInputCommands.mockClear();
    registerBrowserActionObserveCommands.mockClear();
    registerBrowserDebugCommands.mockClear();
    registerBrowserStateCommands.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("registers browser placeholders without loading handlers for help", () => {
    process.argv = ["node", "openclaw", "browser", "--help"];
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, process.argv);

    const browser = program.commands.find((command) => command.name() === "browser");
    expect(browser?.commands.map((command) => command.name())).toContain("status");
    expect(browser?.commands.map((command) => command.name())).toContain("snapshot");
    expect(registerBrowserManageCommands).not.toHaveBeenCalled();
    expect(registerBrowserInspectCommands).not.toHaveBeenCalled();
  });

  it("registers only the primary browser placeholder and dispatches", async () => {
    process.argv = ["node", "openclaw", "browser", "status"];
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, process.argv);

    const browser = program.commands.find((command) => command.name() === "browser");
    expect(browser?.commands.map((command) => command.name())).toEqual(["status"]);

    await program.parseAsync(["browser", "status"], { from: "user" });

    expect(registerBrowserManageCommands).toHaveBeenCalledTimes(1);
    expect(manageAction).toHaveBeenCalledTimes(1);
  });
});
