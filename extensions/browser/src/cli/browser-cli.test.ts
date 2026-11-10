// Browser tests cover browser cli plugin behavior.
import { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBrowserExtensionCommands } from "./browser-cli-extension.js";
import { registerBrowserInspectCommands } from "./browser-cli-inspect.js";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { registerBrowserStateCommands } from "./browser-cli-state.js";
import { registerBrowserCli } from "./browser-cli.js";

vi.mock("../control-service.js", () => {
  throw new Error("Browser CLI registration must not load browser control services");
});
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => {
  throw new Error("Browser CLI registration must not load agent runtime");
});
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", () => {
  throw new Error("Browser CLI registration must not load media understanding runtime");
});
vi.mock("openclaw/plugin-sdk/media-runtime", () => {
  throw new Error("Browser CLI registration must not load media runtime");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Browser CLI root output", () => {
  it("throws a JSON-mode missing-subcommand failure before writing human help", async () => {
    const writeOut = vi.fn();
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("unexpected runtime exit");
    });
    const program = new Command().name("openclaw").configureOutput({ writeOut });
    registerBrowserCli(program, ["node", "openclaw", "browser", "--json"]);

    await expect(program.parseAsync(["browser", "--json"], { from: "user" })).rejects.toThrow(
      'Missing subcommand. Try: "openclaw browser status"',
    );
    expect(writeOut).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps human help and exit 1 when no subcommand is supplied", async () => {
    const writeOut = vi.fn();
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("runtime exit");
    });
    const program = new Command().name("openclaw").configureOutput({ writeOut });
    registerBrowserCli(program, ["node", "openclaw", "browser"]);

    await expect(program.parseAsync(["browser"], { from: "user" })).rejects.toThrow("runtime exit");
    expect(writeOut).toHaveBeenCalledWith(expect.stringContaining("Usage: openclaw browser"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Missing subcommand."));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps explicit help successful even with --json", async () => {
    const writeOut = vi.fn();
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit");
    const program = new Command().name("openclaw").exitOverride().configureOutput({ writeOut });
    registerBrowserCli(program, ["node", "openclaw", "browser", "--json", "--help"]);

    await expect(
      program.parseAsync(["browser", "--json", "--help"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
    expect(writeOut).toHaveBeenCalledWith(expect.stringContaining("Usage: openclaw browser"));
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("Browser CLI import boundary", () => {
  it("registers root help without loading browser services or agent/media runtime", () => {
    const program = new Command();
    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);
    const browser = program.commands[0];
    expect(browser?.helpInformation()).toContain("--browser-profile");
    expect(browser?.commands.map((command) => command.name())).toContain("extension");
  });

  it("registers extension leaves without loading browser services or agent/media runtime", () => {
    const program = new Command();
    const browser = program.command("browser");
    registerBrowserExtensionCommands(browser, () => ({}));
    expect(browser.commands[0]?.commands.map((command) => command.name())).toEqual([
      "native-host",
      "setup",
      "path",
      "install",
      "repair",
      "status",
      "uninstall-store",
      "uninstall-host",
      "pair",
      "cdp",
    ]);
  });

  it("registers Gateway-backed command siblings without loading local browser services", () => {
    const program = new Command();
    const browser = program.command("browser");
    for (const register of [
      registerBrowserManageCommands,
      registerBrowserInspectCommands,
      registerBrowserStateCommands,
    ]) {
      register(browser, () => ({}));
    }
    expect(browser.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "start",
        "doctor",
        "import-profile",
        "snapshot",
        "screenshot",
        "cookies",
        "storage",
        "set",
      ]),
    );
  });
});
