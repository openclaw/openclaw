import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as resolveCliArgvInvocation } from "./argv-invocation-Bmipv42U.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { t as danger } from "./globals-CouSpJO4.js";
import { n as shouldEagerRegisterSubcommands } from "./command-registration-policy-BjvNLrSK.js";
import { t as addGatewayClientOptions } from "./gateway-rpc-Dfnu29I8.js";
import { t as formatHelpExamples } from "./help-format-C6bIKvbJ.js";
import { i as registerCommandGroups } from "./register-command-groups-DYBCwonA.js";
import "./cli-runtime-BuPrSAIi.js";
import "./core-api-Dyca-PBA.js";
//#region extensions/browser/src/cli/browser-cli-examples.ts
const browserCoreExamples = [
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
	"openclaw browser snapshot --labels"
];
const browserActionExamples = [
	"openclaw browser navigate https://example.com",
	"openclaw browser resize 1280 720",
	"openclaw browser click 12 --double",
	"openclaw browser click-coords 120 340",
	"openclaw browser type 23 \"hello\" --submit",
	"openclaw browser press Enter",
	"openclaw browser hover 44",
	"openclaw browser drag 10 11",
	"openclaw browser select 9 OptionA OptionB",
	"openclaw browser upload /tmp/openclaw/uploads/file.pdf",
	"openclaw browser fill --fields '[{\"ref\":\"1\",\"value\":\"Ada\"}]'",
	"openclaw browser dialog --accept",
	"openclaw browser wait --text \"Done\"",
	"openclaw browser evaluate --fn '(el) => el.textContent' --ref 7",
	"openclaw browser console --level error",
	"openclaw browser pdf"
];
//#endregion
//#region extensions/browser/src/cli/browser-cli.ts
const command = (name, description, options) => ({
	name,
	description,
	...options ? { options } : {}
});
const browserCommandGroupDefinitions = [
	{
		placeholders: [
			command("status", "Show browser status"),
			command("start", "Start the browser (no-op if already running)"),
			command("stop", "Stop the browser (best-effort)"),
			command("reset-profile", "Reset browser profile (moves it to Trash)"),
			command("tabs", "List open tabs"),
			command("tab", "Tab shortcuts (index-based)"),
			command("open", "Open a URL in a new tab"),
			command("focus", "Focus a tab by target id, tab id, label, or unique target id prefix"),
			command("close", "Close a tab (target id optional)"),
			command("profiles", "List all browser profiles"),
			command("create-profile", "Create a new browser profile"),
			command("delete-profile", "Delete a browser profile"),
			command("doctor", "Check browser plugin readiness", [{
				flags: "--deep",
				description: "Run a live snapshot probe"
			}])
		],
		register: async (args) => {
			(await import("./browser-cli-manage-BjTSwAtP.js")).registerBrowserManageCommands(args.browser, args.parentOpts);
		}
	},
	{
		placeholders: [command("screenshot", "Capture a screenshot (MEDIA:<path>)"), command("snapshot", "Capture a snapshot (default: ai; aria is the accessibility tree)")],
		register: async (args) => {
			(await import("./browser-cli-inspect-BtqQ1-Jy.js")).registerBrowserInspectCommands(args.browser, args.parentOpts);
		}
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
			command("evaluate", "Evaluate a function against the page or a ref")
		],
		register: async (args) => {
			(await import("./browser-cli-actions-input-CvMx06o5.js")).registerBrowserActionInputCommands(args.browser, args.parentOpts);
		}
	},
	{
		placeholders: [
			command("console", "Get recent console messages"),
			command("pdf", "Save page as PDF"),
			command("responsebody", "Wait for a network response and return its body")
		],
		register: async (args) => {
			(await import("./browser-cli-actions-observe-CiufNYCf.js")).registerBrowserActionObserveCommands(args.browser, args.parentOpts);
		}
	},
	{
		placeholders: [
			command("highlight", "Highlight an element by ref"),
			command("errors", "Get recent page errors"),
			command("requests", "Get recent network requests (best-effort)"),
			command("trace", "Record a Playwright trace")
		],
		register: async (args) => {
			(await import("./browser-cli-debug-C_xOuyiz.js")).registerBrowserDebugCommands(args.browser, args.parentOpts);
		}
	},
	{
		placeholders: [
			command("cookies", "Read/write cookies"),
			command("storage", "Read/write localStorage/sessionStorage"),
			command("set", "Browser environment settings")
		],
		register: async (args) => {
			(await import("./browser-cli-state-Bw72xfZV.js")).registerBrowserStateCommands(args.browser, args.parentOpts);
		}
	}
];
function buildBrowserCommandGroups(params) {
	return browserCommandGroupDefinitions.map((entry) => ({
		placeholders: entry.placeholders,
		register: async () => await entry.register(params)
	}));
}
function registerLazyBrowserCommands(browser, parentOpts, argv) {
	const { primary, commandPath } = resolveCliArgvInvocation(argv);
	const subcommand = primary === "browser" ? commandPath[1] ?? null : null;
	registerCommandGroups(browser, buildBrowserCommandGroups({
		browser,
		parentOpts
	}), {
		eager: shouldEagerRegisterSubcommands(),
		primary: subcommand,
		registerPrimaryOnly: subcommand !== null
	});
}
function registerBrowserCli(program, argv = process.argv) {
	const browser = program.command("browser").description("Manage OpenClaw's dedicated browser (Chrome/Chromium)").option("--browser-profile <name>", "Browser profile name (default from config)").option("--json", "Output machine-readable JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([...browserCoreExamples, ...browserActionExamples].map((cmd) => [cmd, ""]), true)}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/browser", "docs.openclaw.ai/cli/browser")}\n`).action(() => {
		browser.outputHelp();
		defaultRuntime.error(danger(`Missing subcommand. Try: "${formatCliCommand("openclaw browser status")}"`));
		defaultRuntime.exit(1);
	});
	addGatewayClientOptions(browser);
	const parentOpts = (cmd) => cmd.parent?.opts?.();
	registerLazyBrowserCommands(browser, parentOpts, argv);
}
//#endregion
export { registerBrowserCli as t };
