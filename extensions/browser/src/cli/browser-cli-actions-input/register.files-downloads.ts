import type { Command } from "commander";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { shortenHomePath } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveExistingUploadPaths } from "../../browser/paths.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  parseBrowserPositiveIntegerOption,
  runBrowserCliCommand,
  runBrowserCliRequest,
  withBrowserActionTimeoutSlack,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";

const DEFAULT_BROWSER_HOOK_TIMEOUT_MS = 120000;

export function registerBrowserFilesAndDownloadsCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const runHook = async <T = unknown>(
    parent: BrowserParentOpts,
    opts: { timeoutMs?: unknown; targetId?: unknown },
    request: Pick<Parameters<typeof runBrowserCliRequest<T>>[0], "path" | "successMessage"> & {
      body: Record<string, unknown>;
    },
  ) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : undefined;
    await runBrowserCliRequest<T>({
      ...request,
      parent,
      body: {
        ...request.body,
        targetId: normalizeOptionalString(opts.targetId),
        timeoutMs,
      },
      timeoutMs: withBrowserActionTimeoutSlack(timeoutMs ?? DEFAULT_BROWSER_HOOK_TIMEOUT_MS),
      errorPolicy: "inline",
    });
  };

  browser
    .command("upload")
    .description("Arm file upload for the next file chooser")
    .argument(
      "<paths...>",
      "File paths to upload from OpenClaw temp uploads or managed inbound media (e.g. /tmp/openclaw/uploads/file.pdf or media://inbound/<id>)",
    )
    .option("--ref <ref>", "Ref id from snapshot to click after arming")
    .option("--input-ref <ref>", "Ref id for <input type=file> to set directly")
    .option("--element <selector>", "CSS selector for <input type=file>")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next file chooser (default: 120000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .action(async (paths: string[], opts, cmd) => {
      await runBrowserCliCommand(async () => {
        const parent = parentOpts(cmd);
        const resolved = await resolveExistingUploadPaths({ requestedPaths: paths });
        if (!resolved.ok) {
          throw new Error(resolved.error);
        }
        await runHook(parent, opts, {
          path: "/hooks/file-chooser",
          body: {
            paths: resolved.paths,
            ref: normalizeOptionalString(opts.ref),
            inputRef: normalizeOptionalString(opts.inputRef),
            element: normalizeOptionalString(opts.element),
          },
          successMessage: `upload armed for ${paths.length} file(s)`,
        });
      }, "inline");
    });

  browser
    .command("waitfordownload")
    .description("Wait for the next download (and save it)")
    .argument(
      "[path]",
      "Save path within openclaw temp downloads dir (default: /tmp/openclaw/downloads/...; fallback: os.tmpdir()/openclaw/downloads/...)",
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next download (default: 120000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .action(async (outPath: string | undefined, opts, cmd) => {
      await runHook<{ download: { path: string } }>(parentOpts(cmd), opts, {
        path: "/wait/download",
        body: {
          path: normalizeOptionalString(outPath),
        },
        successMessage: (result) => `downloaded: ${shortenHomePath(result.download.path)}`,
      });
    });

  browser
    .command("download")
    .description("Click a ref and save the resulting download")
    .argument("<ref>", "Ref id from snapshot to click")
    .argument(
      "<path>",
      "Save path within openclaw temp downloads dir (e.g. report.pdf or /tmp/openclaw/downloads/report.pdf)",
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the download to start (default: 120000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .action(async (ref: string, outPath: string, opts, cmd) => {
      await runHook<{ download: { path: string } }>(parentOpts(cmd), opts, {
        path: "/download",
        body: {
          ref,
          path: outPath,
        },
        successMessage: (result) => `downloaded: ${shortenHomePath(result.download.path)}`,
      });
    });

  browser
    .command("dialog")
    .description("Arm the next modal dialog (alert/confirm/prompt)")
    .option("--accept", "Accept the dialog", false)
    .option("--dismiss", "Dismiss the dialog", false)
    .option("--prompt <text>", "Prompt response text")
    .option("--dialog-id <id>", "Pending dialog id from snapshot/browser state")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next dialog (default: 120000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      if (opts.accept && opts.dismiss) {
        defaultRuntime.error(danger("Specify only one of --accept or --dismiss"));
        defaultRuntime.exit(1);
        return;
      }
      const accept = opts.accept ? true : opts.dismiss ? false : undefined;
      if (accept === undefined) {
        defaultRuntime.error(danger("Specify --accept or --dismiss"));
        defaultRuntime.exit(1);
        return;
      }
      await runHook(parent, opts, {
        path: "/hooks/dialog",
        body: {
          accept,
          promptText: readStringValue(opts.prompt),
          dialogId: normalizeOptionalString(opts.dialogId),
        },
        successMessage: "dialog armed",
      });
    });
}
