import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { readRegularFile } from "openclaw/plugin-sdk/file-access-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { z } from "zod";
import type { BrowserStatus } from "../browser/client.types.js";
import {
  NATIVE_POLICY_MAX_BYTES,
  nativePolicyInputSchema,
  verifyNativeBrowserPolicy,
  type NativePolicySetupPlan,
} from "../browser/native-policy-setup.js";
import type { NativeBrowserPolicyReport } from "../browser/native-policy.js";
import { shellQuote as quote } from "../browser/native-shell-quote.js";
import {
  callBrowserRequest,
  resolveBrowserProfileQuery,
  runBrowserCliCommand,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";

/** Commands run by an administrator on the browser host, never by the Gateway. */
function nativePolicyOperatorCommand(
  plan: Extract<NativePolicySetupPlan, { state: "ready" }>,
): string {
  if (plan.operation === "inspect") {
    throw new Error("Inspection does not authorize an installation command; request a setup plan.");
  }
  const target = plan.targetPath;
  if (
    ![
      "/etc/opt/chrome/policies/managed/openclaw.json",
      "/etc/chromium/policies/managed/openclaw.json",
    ].includes(target)
  ) {
    throw new Error("Unexpected native policy target; plan again with a supported browser host.");
  }
  const directory = path.posix.dirname(target);
  const lines = ["set -eu", `target=${quote(target)}`];
  // Fixed system paths must remain direct directories at operator execution time.
  let ancestor = directory;
  while (ancestor !== "/") {
    lines.push(
      `[ ! -L ${quote(ancestor)} ] || { echo 'Symlinked policy directory; plan again' >&2; exit 1; }`,
    );
    ancestor = path.posix.dirname(ancestor);
  }
  const checkPrevious =
    plan.previousHash === null
      ? `[ ! -e "$target" ] && [ ! -L "$target" ] || { echo 'Policy artifact appeared; plan again' >&2; exit 1; }`
      : `[ ! -L "$target" ] && [ -f "$target" ] && [ "$(stat -c %h "$target")" = 1 ] && [ "$(sha256sum "$target" | cut -d ' ' -f 1)" = ${quote(
          z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .parse(plan.previousHash),
        )} ] || { echo 'Policy artifact changed; plan again' >&2; exit 1; }`;
  if (plan.operation === "remove") {
    lines.push(checkPrevious, 'rm -- "$target"');
  } else {
    const expectedHash = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(plan.contentHash);
    lines.push(
      `artifact="$PWD/openclaw-policy.json"`,
      `[ ! -L "$artifact" ] && [ -f "$artifact" ] && [ "$(sha256sum "$artifact" | cut -d ' ' -f 1)" = ${quote(expectedHash)} ] || { echo 'Exported policy artifact changed or is missing' >&2; exit 1; }`,
      `mkdir -p -- ${quote(directory)}`,
      // Chromium reads files in managed/ regardless of extension; stage outside it.
      `staged=$(mktemp ${quote(path.posix.dirname(directory) + "/.openclaw-policy.XXXXXX")})`,
      `trap 'rm -f -- "$staged"' EXIT`,
      // A replaced user-owned input must not expose root-readable content
      // while copying. Publish permissions only after proving the approved hash.
      'install -m 0600 -o root -g root -- "$artifact" "$staged"',
      `[ "$(sha256sum "$staged" | cut -d ' ' -f 1)" = ${quote(expectedHash)} ] || { echo 'Artifact changed while staging' >&2; exit 1; }`,
      'chmod 0644 -- "$staged"',
      checkPrevious,
      plan.previousHash === null ? 'ln -- "$staged" "$target"' : 'mv -T -- "$staged" "$target"',
    );
  }
  return `sudo sh -c ${quote(lines.join("\n"))}`;
}

async function readPolicies(file: string): Promise<z.infer<typeof nativePolicyInputSchema>> {
  try {
    const { buffer } = await readRegularFile({
      filePath: path.resolve(file),
      maxBytes: NATIVE_POLICY_MAX_BYTES,
    });
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    return nativePolicyInputSchema.parse(parsed);
  } catch {
    throw new Error(
      "Cannot read --file as native policy JSON. Provide a readable regular file containing a nonempty JSON object within 64 KiB; check the path, permissions, JSON syntax and rendered size.",
    );
  }
}

async function confirmExport(yes: boolean | undefined): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    defaultRuntime.log(
      "Preview only. Pass --yes to export the artifact and administrator command after reviewing the machine policy scope.",
    );
    return false;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      (await prompt.question("Export this policy artifact and administrator command? [y/N] "))
        .trim()
        .toLowerCase() === "y"
    );
  } finally {
    prompt.close();
  }
}

export function registerBrowserPolicySetupCommands(
  policy: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
): void {
  for (const operation of ["install", "remove"] as const) {
    const command = policy
      .command(operation === "install" ? "setup" : "remove")
      .description(
        operation === "install"
          ? "Preview and export native Linux machine policy; an administrator installs it on the browser host"
          : "Preview guarded removal of only the OpenClaw native policy artifact",
      )
      .option("--yes", "Confirm exporting the reviewed artifact and administrator command", false);
    if (operation === "install") {
      command
        .requiredOption("--file <path>", "Native policy JSON object (maximum 64 KiB)")
        .option(
          "--output <path>",
          "New private artifact on this CLI machine; copy to browser host as openclaw-policy.json",
          "openclaw-policy.json",
        );
    }
    command.action(
      async (opts: { file?: string; output?: string; yes?: boolean }, cmd: Command) => {
        await runBrowserCliCommand(async () => {
          const parent = parentOpts(cmd);
          const requestPlan = (body: Parameters<typeof callBrowserRequest>[1]["body"]) =>
            callBrowserRequest<NativePolicySetupPlan>(parent, {
              method: "POST",
              path: "/policy/setup/plan",
              query: resolveBrowserProfileQuery(parent.browserProfile),
              body,
            });
          const inspection = await requestPlan({ operation: "inspect" });
          if (inspection.state !== "ready") {
            if (parent.json) {
              defaultRuntime.writeJson(inspection);
            } else {
              defaultRuntime.log(sanitizeTerminalText(`${inspection.state}: ${inspection.detail}`));
            }
            return;
          }
          const policies =
            operation === "install" && opts.file ? await readPolicies(opts.file) : undefined;
          const plan = await requestPlan(
            operation === "install" ? { operation, policies } : { operation },
          );
          if (plan.state !== "ready") {
            if (parent.json) {
              defaultRuntime.writeJson(plan);
            } else {
              defaultRuntime.log(sanitizeTerminalText(`${plan.state}: ${plan.detail}`));
            }
            return;
          }
          const output = opts.output ? path.resolve(opts.output) : null;
          if (!parent.json) {
            defaultRuntime.log(
              sanitizeTerminalText(
                `Plan ${plan.operation}: ${plan.browser} (${plan.executablePath}) on browser host ${plan.browserHost}`,
              ),
            );
            defaultRuntime.log(
              `Target: ${plan.targetPath}\nScope: mandatory machine policy for all browser users and profiles; root administrator access required.`,
            );
            defaultRuntime.log(
              "Existing OS and MDM policies remain managed by their owners. Chromium determines conflicts, precedence and validity.",
            );
            for (const [name, current] of Object.entries(plan.currentPolicies)) {
              defaultRuntime.log(sanitizeTerminalText(`${name}: ${JSON.stringify(current)}`));
            }
            if (plan.content) {
              defaultRuntime.log("Requested native artifact:");
              for (const line of plan.content.split("\n")) {
                defaultRuntime.log(sanitizeTerminalText(line));
              }
            }
            if (policies?.RemoteDebuggingAllowed === false) {
              defaultRuntime.log(
                "RemoteDebuggingAllowed: false will disable OpenClaw browser control after activation. Automatic verification will be unavailable; use chrome://policy manually with the browser administrator.",
              );
            }
            if (output) {
              defaultRuntime.log(
                sanitizeTerminalText(
                  `Private export on this CLI machine: ${output} (0600). Native policy values may contain sensitive URLs or settings.`,
                ),
              );
            }
          }
          if ((parent.json && !opts.yes) || !(await confirmExport(opts.yes))) {
            if (parent.json) {
              defaultRuntime.writeJson({ ...plan, state: "prepared", exported: false });
            } else {
              defaultRuntime.log("Preview or export cancelled; system policy unchanged.");
            }
            return;
          }
          const operatorCommand = nativePolicyOperatorCommand(plan);
          if (plan.content !== null && output) {
            if (createHash("sha256").update(plan.content).digest("hex") !== plan.contentHash) {
              throw new Error("Policy artifact hash mismatch; plan again.");
            }
            const artifact = await fs.open(output, "wx", 0o600);
            try {
              await artifact.writeFile(plan.content, "utf8");
            } finally {
              await artifact.close();
            }
          }
          const activation =
            operation === "remove"
              ? "On the browser host, reload chrome://policy and restart manually if required. Then run openclaw browser policy and openclaw browser doctor --deep using the same Gateway and profile; inspect remaining OS and MDM policies and browser control readiness."
              : "On the browser host, reload chrome://policy; restart the browser manually if its native diagnostics require it. Then run openclaw browser policy verify --file <original-policy.json> using the same Gateway and profile.";
          if (parent.json) {
            defaultRuntime.writeJson({
              ...plan,
              state: "awaiting-operator-action",
              exported: true,
              output,
              operatorCommand,
              activation,
              ...(policies?.RemoteDebuggingAllowed === false
                ? {
                    warning:
                      "This policy disables OpenClaw browser control after activation. Verify manually in chrome://policy; automatic verification will be unavailable.",
                  }
                : {}),
            });
          } else {
            if (output) {
              defaultRuntime.log(
                "Copy the private export to the browser host as ./openclaw-policy.json. From that directory, review and run this administrator command on that host:",
              );
            } else {
              defaultRuntime.log("Review and run this administrator command on the browser host:");
            }
            defaultRuntime.log(operatorCommand);
            defaultRuntime.log(
              "Awaiting operator action; exporting does not install or activate policy.",
            );
            defaultRuntime.log(activation);
          }
        });
      },
    );
  }
  policy
    .command("verify")
    .description("Compare requested JSON with fresh native policy and browser control readiness")
    .requiredOption("--file <path>", "Original native policy JSON object")
    .action(async (opts: { file: string }, command: Command) => {
      await runBrowserCliCommand(async () => {
        const parent = parentOpts(command);
        const policies = await readPolicies(opts.file);
        const request = {
          method: "GET" as const,
          query: resolveBrowserProfileQuery(parent.browserProfile),
        };
        const report = await callBrowserRequest<NativeBrowserPolicyReport>(parent, {
          ...request,
          path: "/policy",
        });
        const status = await callBrowserRequest<BrowserStatus>(parent, { ...request, path: "/" });
        const verification = verifyNativeBrowserPolicy({
          policies,
          report,
          controlReady: status.pageReady ?? status.cdpReady ?? false,
        });
        if (parent.json) {
          defaultRuntime.writeJson({ ...verification, report });
        } else {
          defaultRuntime.log(
            `${verification.stage}: requested native policy; browser control ${verification.controlReady ? "ready" : "unavailable"}`,
          );
          for (const issue of verification.issues) {
            defaultRuntime.log(sanitizeTerminalText(`${issue.policy}: ${issue.detail}`));
          }
          for (const warning of verification.warnings) {
            defaultRuntime.log(
              sanitizeTerminalText(`${warning.policy}: warning: ${warning.detail}`),
            );
          }
        }
        if (verification.state !== "verified") {
          defaultRuntime.exit(1);
        }
      });
    });
}
