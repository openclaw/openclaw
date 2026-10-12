import type { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { NativeBrowserPolicyReport } from "../browser/native-policy.js";
import { runBrowserCliRequest, type BrowserParentOpts } from "./browser-cli-shared.js";

export function registerBrowserPolicyCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
): void {
  browser
    .command("policy")
    .description("Inspect the running browser's effective native enterprise policy")
    .action(async (_opts, command: Command) => {
      await runBrowserCliRequest<NativeBrowserPolicyReport>({
        parent: parentOpts(command),
        method: "GET",
        path: "/policy",
        print: (report) => {
          if (!("policies" in report)) {
            defaultRuntime.log(sanitizeTerminalText(`${report.state}: ${report.detail}`));
            return;
          }
          defaultRuntime.log(
            sanitizeTerminalText(`${report.state}: ${report.browser} ${report.version}`),
          );
          for (const [name, policy] of Object.entries(report.policies)) {
            defaultRuntime.log(
              sanitizeTerminalText(
                `${name}: ${JSON.stringify(policy.value)} (${policy.level}, ${policy.scope}, ${policy.source})${policy.ignored ? "; ignored" : ""}${policy.error ? `; error: ${policy.error}` : ""}${policy.warning ? `; warning: ${policy.warning}` : ""}`,
              ),
            );
          }
        },
      });
    });
}
