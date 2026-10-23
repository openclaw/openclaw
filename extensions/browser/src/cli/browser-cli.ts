import type { Command } from "commander";
import {
  registerCommandGroups,
  shouldEagerRegisterSubcommands,
  type CommandGroupPlaceholder,
  type CommandGroupEntry,
  formatCliCommand,
  formatHelpExamples,
  theme,
} from "openclaw/plugin-sdk/cli-runtime";
import { addGatewayClientOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveBrowserLazySubcommand } from "../../cli-output-mode.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

const browserExamples = [
  "openclaw browser status",
  "openclaw browser start",
  "openclaw browser start --headless",
  "openclaw browser stop",
  "openclaw browser tabs",
  "openclaw browser open https://example.com",
  "openclaw browser focus abcd1234",
  "openclaw browser close abcd1234",
  "openclaw browser screenshot",
  "openclaw browser screenshot --full-page",
  "openclaw browser screenshot --ref 12",
  "openclaw browser snapshot",
  "openclaw browser snapshot --format aria --limit 200",
  "openclaw browser snapshot --efficient",
  "openclaw browser snapshot --labels",
  "openclaw browser navigate https://example.com",
  "openclaw browser resize 1280 720",
  "openclaw browser click 12 --double",
  "openclaw browser click-coords 120 340",
  'openclaw browser type 23 "hello" --submit',
  "openclaw browser press Enter",
  "openclaw browser hover 44",
  "openclaw browser drag 10 11",
  "openclaw browser select 9 OptionA OptionB",
  "openclaw browser upload /tmp/openclaw/uploads/file.pdf",
  "openclaw browser upload media://inbound/file.pdf",
  'openclaw browser fill --fields \'[{"ref":"1","value":"Ada"}]\'',
  "openclaw browser dialog --accept",
  'openclaw browser wait --text "Done"',
  "openclaw browser evaluate --fn '(el) => el.textContent' --ref 7",
  "openclaw browser evaluate --fn 'const title = document.title; return title;'",
  "openclaw browser console --level error",
  "openclaw browser pdf",
  "openclaw browser batch --actions-file plan.json",
  'openclaw browser batch --actions \'[{"kind":"wait","timeMs":500},{"kind":"click","ref":"12"},{"kind":"type","ref":"23","text":"hello"}]\'',
  "openclaw browser batch --actions-file plan.json --continue",
];

const command = (
  name: string,
  description: string,
  options?: CommandGroupPlaceholder["options"],
): CommandGroupPlaceholder => ({
  name,
  description,
  ...(options ? { options } : {}),
});

function browserCommandGroups(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
  pluginRoot?: string,
): CommandGroupEntry[] {
  return [
    {
      placeholders: [
        command("status", "Show browser status"),
        command("start", "Start the browser (no-op if already running)"),
        command("stop", "Stop the browser (best-effort)"),
        command("reset-profile", "Reset browser profile (moves it to Trash)"),
        command("tabs", "List open tabs"),
        command("tab", "Tab shortcuts (index-based)"),
        command("open", "Open a URL in a new tab"),
        command("focus", "Focus a tab by tab reference"),
        command("close", "Close a tab (tab reference optional)"),
        command("profiles", "List all browser profiles"),
        command("system-profiles", "List Chrome-family profiles available for cookie import"),
        command("import-profile", "Import cookies from a macOS Chrome-family profile"),
        command("create-profile", "Create a new browser profile"),
        command("delete-profile", "Delete a browser profile"),
        command("doctor", "Check browser plugin readiness", [
          { flags: "--deep", description: "Run a live snapshot check" },
        ]),
      ],
      register: async () => {
        const module = await import("./browser-cli-manage.js");
        module.registerBrowserManageCommands(browser, parentOpts);
      },
    },
    {
      placeholders: [
        command("cookie-sync", "Sync allowlisted macOS browser cookies to a managed profile"),
      ],
      register: async () => {
        const module = await import("./browser-cli-cookie-sync.js");
        module.registerBrowserCookieSyncCommand(browser, parentOpts);
      },
    },
    {
      placeholders: [
        command("screenshot", "Capture a screenshot (prints the saved path)"),
        command("snapshot", "Capture a snapshot (default: ai; aria is the accessibility tree)"),
      ],
      register: async () => {
        const module = await import("./browser-cli-inspect.js");
        module.registerBrowserInspectCommands(browser, parentOpts);
      },
    },
    {
      placeholders: [
        command("navigate", "Navigate the current tab to a URL"),
        command("resize", "Resize the viewport"),
        command("click", "Click an element by ref from snapshot"),
        command("click-coords", "Click viewport coordinates"),
        command("type", "Type into an element by ref from snapshot"),
        command("press", "Press a key"),
        command("hover", "Hover an element by ai ref"),
        command("scrollintoview", "Scroll an element into view by ref from snapshot"),
        command("drag", "Drag from one ref to another"),
        command("select", "Select option(s) in a select element"),
        command("upload", "Arm file upload for the next file chooser"),
        command("waitfordownload", "Wait for the next download (and save it)"),
        command("download", "Click a ref and save the resulting download"),
        command("dialog", "Arm the next modal dialog (alert/confirm/prompt)"),
        command("fill", "Fill a form with JSON field descriptors"),
        command("wait", "Wait for time, selector, URL, load state, or JS conditions"),
        command("evaluate", "Evaluate a function against the page or a ref"),
        command("batch", "Run a batch of browser actions in one call"),
      ],
      register: async () => {
        const module = await import("./browser-cli-actions-input/register.js");
        module.registerBrowserActionInputCommands(browser, parentOpts);
      },
    },
    {
      placeholders: [
        command("console", "Get recent console messages"),
        command("pdf", "Save page as PDF"),
        command("responsebody", "Wait for a network response and return its body"),
      ],
      register: async () => {
        const module = await import("./browser-cli-actions-observe.js");
        module.registerBrowserActionObserveCommands(browser, parentOpts);
      },
    },
    {
      placeholders: [
        command("highlight", "Highlight an element by ref"),
        command("errors", "Get recent page errors"),
        command("requests", "Get recent network requests (best-effort)"),
        command("trace", "Record a Playwright trace"),
      ],
      register: async () => {
        const module = await import("./browser-cli-debug.js");
        module.registerBrowserDebugCommands(browser, parentOpts);
      },
    },
    {
      placeholders: [
        command("cookies", "Read/write cookies"),
        command("storage", "Read/write localStorage/sessionStorage"),
        command("set", "Browser environment settings"),
      ],
      register: async () => {
        const module = await import("./browser-cli-state.js");
        module.registerBrowserStateCommands(browser, parentOpts);
      },
    },
    {
      placeholders: [command("extension", "Chrome extension install, status, and pairing")],
      register: async () => {
        const module = await import("./browser-cli-extension.js");
        module.registerBrowserExtensionCommands(browser, parentOpts, pluginRoot);
      },
    },
  ];
}

export function registerBrowserCli(
  program: Command,
  argv: string[] = process.argv,
  pluginRoot?: string,
) {
  const browser = program
    .command("browser")
    .description("Manage OpenClaw's dedicated browser (Chrome/Chromium)")
    .option("--browser-profile <name>", "Browser profile name (default from config)")
    .option("--json", "Output machine-readable JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(
          browserExamples.map((cmd) => [cmd, ""]),
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

  const parentOpts = () => browser.opts<BrowserParentOpts>();

  const subcommand = resolveBrowserLazySubcommand(argv);
  registerCommandGroups(browser, browserCommandGroups(browser, parentOpts, pluginRoot), {
    eager: shouldEagerRegisterSubcommands(),
    primary: subcommand,
    registerPrimaryOnly: subcommand !== null,
  });
}
