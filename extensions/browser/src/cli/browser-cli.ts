import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../../../../src/cli/argv-invocation.js";
import { shouldEagerRegisterSubcommands } from "../../../../src/cli/command-registration-policy.js";
import {
  registerCommandGroups,
  type CommandGroupEntry,
} from "../../../../src/cli/program/register-command-groups.js";
import { browserActionExamples, browserCoreExamples } from "./browser-cli-examples.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import {
  addGatewayClientOptions,
  danger,
  defaultRuntime,
  formatCliCommand,
  formatDocsLink,
  formatHelpExamples,
  theme,
} from "./core-api.js";

const browserCommandDescriptors = [
  { name: "status", description: "Show browser status", hasSubcommands: false },
  {
    name: "start",
    description: "Start the browser (no-op if already running)",
    hasSubcommands: false,
  },
  { name: "stop", description: "Stop the browser (best-effort)", hasSubcommands: false },
  {
    name: "reset-profile",
    description: "Reset browser profile (moves it to Trash)",
    hasSubcommands: false,
  },
  { name: "tabs", description: "List open tabs", hasSubcommands: false },
  { name: "tab", description: "Tab shortcuts (index-based)", hasSubcommands: true },
  { name: "open", description: "Open a URL in a new tab", hasSubcommands: false },
  {
    name: "focus",
    description: "Focus a tab by target id (or unique prefix)",
    hasSubcommands: false,
  },
  { name: "close", description: "Close a tab (target id optional)", hasSubcommands: false },
  { name: "profiles", description: "List all browser profiles", hasSubcommands: false },
  { name: "create-profile", description: "Create a new browser profile", hasSubcommands: false },
  { name: "delete-profile", description: "Delete a browser profile", hasSubcommands: false },
  { name: "screenshot", description: "Capture a screenshot (MEDIA:<path>)", hasSubcommands: false },
  {
    name: "snapshot",
    description: "Capture a snapshot (default: ai; aria is the accessibility tree)",
    hasSubcommands: false,
  },
  { name: "navigate", description: "Navigate the current tab to a URL", hasSubcommands: false },
  { name: "resize", description: "Resize the viewport", hasSubcommands: false },
  { name: "click", description: "Click an element by ref from snapshot", hasSubcommands: false },
  { name: "type", description: "Type into an element by ref from snapshot", hasSubcommands: false },
  { name: "press", description: "Press a key", hasSubcommands: false },
  { name: "hover", description: "Hover an element by ai ref", hasSubcommands: false },
  {
    name: "scrollintoview",
    description: "Scroll an element into view by ref from snapshot",
    hasSubcommands: false,
  },
  { name: "drag", description: "Drag from one ref to another", hasSubcommands: false },
  { name: "select", description: "Select option(s) in a select element", hasSubcommands: false },
  {
    name: "upload",
    description: "Arm file upload for the next file chooser",
    hasSubcommands: false,
  },
  {
    name: "waitfordownload",
    description: "Wait for the next download (and save it)",
    hasSubcommands: false,
  },
  {
    name: "download",
    description: "Click a ref and save the resulting download",
    hasSubcommands: false,
  },
  {
    name: "dialog",
    description: "Arm the next modal dialog (alert/confirm/prompt)",
    hasSubcommands: false,
  },
  { name: "fill", description: "Fill a form with JSON field descriptors", hasSubcommands: false },
  {
    name: "wait",
    description: "Wait for time, selector, URL, load state, or JS conditions",
    hasSubcommands: false,
  },
  {
    name: "evaluate",
    description: "Evaluate a function against the page or a ref",
    hasSubcommands: false,
  },
  { name: "console", description: "Get recent console messages", hasSubcommands: false },
  { name: "pdf", description: "Save page as PDF", hasSubcommands: false },
  {
    name: "responsebody",
    description: "Wait for a network response and return its body",
    hasSubcommands: false,
  },
  { name: "highlight", description: "Highlight an element by ref", hasSubcommands: false },
  { name: "errors", description: "Get recent page errors", hasSubcommands: false },
  {
    name: "requests",
    description: "Get recent network requests (best-effort)",
    hasSubcommands: false,
  },
  { name: "trace", description: "Record a Playwright trace", hasSubcommands: true },
  { name: "cookies", description: "Read/write cookies", hasSubcommands: true },
  { name: "storage", description: "Read/write localStorage/sessionStorage", hasSubcommands: true },
  { name: "set", description: "Browser environment settings", hasSubcommands: true },
] as const;

function makeCommandGroupEntry(
  commandNames: readonly string[],
  register: () => Promise<void>,
): CommandGroupEntry {
  return {
    placeholders: browserCommandDescriptors.filter((descriptor) =>
      commandNames.includes(descriptor.name),
    ),
    register,
  };
}

function registerLazyBrowserCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
  argv: string[] = process.argv,
) {
  const { primary, commandPath } = resolveCliArgvInvocation(argv);
  const [, subcommand] = commandPath;
  const commandGroups: CommandGroupEntry[] = [
    makeCommandGroupEntry(
      [
        "status",
        "start",
        "stop",
        "reset-profile",
        "tabs",
        "tab",
        "open",
        "focus",
        "close",
        "profiles",
        "create-profile",
        "delete-profile",
      ],
      async () => {
        const module = await import("./browser-cli-manage.js");
        module.registerBrowserManageCommands(browser, parentOpts);
      },
    ),
    makeCommandGroupEntry(["screenshot", "snapshot"], async () => {
      const module = await import("./browser-cli-inspect.js");
      module.registerBrowserInspectCommands(browser, parentOpts);
    }),
    makeCommandGroupEntry(
      [
        "navigate",
        "resize",
        "click",
        "type",
        "press",
        "hover",
        "scrollintoview",
        "drag",
        "select",
        "upload",
        "waitfordownload",
        "download",
        "dialog",
        "fill",
        "wait",
        "evaluate",
      ],
      async () => {
        const module = await import("./browser-cli-actions-input.js");
        module.registerBrowserActionInputCommands(browser, parentOpts);
      },
    ),
    makeCommandGroupEntry(["console", "pdf", "responsebody"], async () => {
      const module = await import("./browser-cli-actions-observe.js");
      module.registerBrowserActionObserveCommands(browser, parentOpts);
    }),
    makeCommandGroupEntry(["highlight", "errors", "requests", "trace"], async () => {
      const module = await import("./browser-cli-debug.js");
      module.registerBrowserDebugCommands(browser, parentOpts);
    }),
    makeCommandGroupEntry(["cookies", "storage", "set"], async () => {
      const module = await import("./browser-cli-state.js");
      module.registerBrowserStateCommands(browser, parentOpts);
    }),
  ];

  registerCommandGroups(browser, commandGroups, {
    eager: shouldEagerRegisterSubcommands(),
    primary: primary === "browser" ? subcommand : null,
    registerPrimaryOnly: primary === "browser" && Boolean(subcommand),
  });
}

export function registerBrowserCli(program: Command, argv: string[] = process.argv) {
  const browser = program
    .command("browser")
    .description("Manage OpenClaw's dedicated browser (Chrome/Chromium)")
    .option("--browser-profile <name>", "Browser profile name (default from config)")
    .option("--json", "Output machine-readable JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(
          [...browserCoreExamples, ...browserActionExamples].map((cmd) => [cmd, ""]),
          true,
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/browser",
          "docs.openclaw.ai/cli/browser",
        )}\n`,
    )
    .action(() => {
      browser.outputHelp();
      defaultRuntime.error(
        danger(`Missing subcommand. Try: "${formatCliCommand("openclaw browser status")}"`),
      );
      defaultRuntime.exit(1);
    });

  addGatewayClientOptions(browser);

  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;

  registerLazyBrowserCommands(browser, parentOpts, argv);
}
