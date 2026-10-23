import type { Command } from "commander";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { shortenHomePath } from "openclaw/plugin-sdk/text-utility-runtime";
import type { BrowserActRequest } from "../../browser/client-actions.types.js";
import { resolveExistingUploadPaths } from "../../browser/paths.js";
import { registerBrowserResizeCommand } from "../browser-cli-resize.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliCommand,
  runBrowserCliRequest,
  withBrowserActionTimeoutSlack,
  parseBrowserNonNegativeIntegerOption,
  parseBrowserPositiveIntegerOption,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";
import {
  runBrowserAction,
  requireRef,
  readFields,
  readActionsPayload,
  parseBrowserInputArray,
} from "./shared.js";

function parseBrowserMouseButtonOption(value: string): "left" | "right" | "middle" {
  if (value === "left" || value === "right" || value === "middle") {
    return value;
  }
  throw Object.assign(new Error("--button must be left, right, or middle."), {
    name: "InvalidArgumentError",
    code: "commander.invalidArgument",
    exitCode: 1,
  });
}

function clickSuccessMessage(message: string) {
  return ({ url }: { url?: string }) =>
    `${message}${typeof url === "string" && url ? ` on ${url}` : ""}`;
}

const DEFAULT_BROWSER_HOOK_TIMEOUT_MS = 120000;

function parseBrowserWaitLoadState(value: unknown) {
  const load = normalizeOptionalString(value);
  switch (load) {
    case undefined:
      return undefined;
    case "load":
    case "domcontentloaded":
    case "networkidle":
      return load;
    default:
      throw new Error(`Invalid --load value: ${load}`);
  }
}

export function registerBrowserActionInputCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("navigate")
    .description("Navigate the current tab to a URL")
    .argument("<url>", "URL to navigate to")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (url: string, opts, cmd) => {
      await runBrowserCliRequest<{ url?: string }>({
        parent: parentOpts(cmd),
        path: "/navigate",
        body: { url, targetId: normalizeOptionalString(opts.targetId) },
        errorPolicy: "inline",
        successMessage: (result) => `navigated to ${result.url ?? url}`,
      });
    });

  registerBrowserResizeCommand(
    browser.command("resize").description("Resize the viewport"),
    parentOpts,
  );

  const parseRequiredNumber = (value: string, label: string): number | undefined => {
    const trimmed = value.trim();
    const parsed = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      defaultRuntime.error(danger(`Invalid ${label}: must be a finite number`));
      defaultRuntime.exit(1);
      return undefined;
    }
    return parsed;
  };

  const runElementAction = async (params: {
    cmd: Command;
    body: BrowserActRequest;
    successMessage: string | ((result: { url?: string }) => string);
  }): Promise<void> => {
    const parent = parentOpts(params.cmd);
    await runBrowserCliCommand(async () => {
      await runBrowserAction({
        parent,
        body: params.body,
        successMessage: params.successMessage,
      });
    });
  };

  browser
    .command("click")
    .description("Click an element by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option("--double", "Double click", false)
    .option("--button <left|right|middle>", "Mouse button to use", parseBrowserMouseButtonOption)
    .option("--modifiers <list>", "Comma-separated modifiers (Shift,Alt,Meta)")
    .action(async (ref: string | undefined, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      const modifiers = opts.modifiers
        ? String(opts.modifiers)
            .split(",")
            .map((v: string) => v.trim())
            .filter(Boolean)
        : undefined;
      await runElementAction({
        cmd,
        body: {
          kind: "click",
          ref: refValue,
          targetId: normalizeOptionalString(opts.targetId),
          doubleClick: Boolean(opts.double),
          button: normalizeOptionalString(opts.button),
          modifiers,
        },
        successMessage: clickSuccessMessage(`clicked ref ${refValue}`),
      });
    });

  browser
    .command("click-coords")
    .description("Click viewport coordinates")
    .argument("<x>", "Viewport x coordinate")
    .argument("<y>", "Viewport y coordinate")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option("--double", "Double click", false)
    .option("--button <left|right|middle>", "Mouse button to use", parseBrowserMouseButtonOption)
    .option("--delay-ms <ms>", "Delay between mouse down/up", (v: string) =>
      parseBrowserNonNegativeIntegerOption(v, "--delay-ms"),
    )
    .action(async (xRaw: string, yRaw: string, opts, cmd) => {
      const x = parseRequiredNumber(xRaw, "x");
      const y = parseRequiredNumber(yRaw, "y");
      if (x === undefined || y === undefined) {
        return;
      }
      await runElementAction({
        cmd,
        body: {
          kind: "clickCoords",
          x,
          y,
          targetId: normalizeOptionalString(opts.targetId),
          doubleClick: Boolean(opts.double),
          button: normalizeOptionalString(opts.button),
          delayMs: opts.delayMs,
        },
        successMessage: clickSuccessMessage(`clicked ${x},${y}`),
      });
    });

  browser
    .command("type")
    .description("Type into an element by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .argument("<text>", "Text to type")
    .option("--submit", "Press Enter after typing", false)
    .option("--slowly", "Type slowly (human-like)", false)
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (ref: string | undefined, text: string, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      await runElementAction({
        cmd,
        body: {
          kind: "type",
          ref: refValue,
          text,
          submit: Boolean(opts.submit),
          slowly: Boolean(opts.slowly),
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `typed into ref ${refValue}`,
      });
    });

  for (const [kind, description, argument, argumentHelp, message] of [
    ["press", "Press a key", "key", "Key to press (e.g. Enter)", "pressed"],
    ["hover", "Hover an element by ai ref", "ref", "Ref id from snapshot", "hovered ref"],
  ] as const) {
    browser
      .command(kind)
      .description(description)
      .argument(`<${argument}>`, argumentHelp)
      .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
      .action(async (value: string, opts, cmd) => {
        await runElementAction({
          cmd,
          body: {
            ...(kind === "press" ? { kind, key: value } : { kind, ref: value }),
            targetId: normalizeOptionalString(opts.targetId),
          },
          successMessage: `${message} ${value}`,
        });
      });
  }

  browser
    .command("scrollintoview")
    .description("Scroll an element into view by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option("--timeout-ms <ms>", "How long to wait for scroll (default: 20000)", (v: string) =>
      parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .action(async (ref: string | undefined, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      await runElementAction({
        cmd,
        body: {
          kind: "scrollIntoView",
          ref: refValue,
          targetId: normalizeOptionalString(opts.targetId),
          timeoutMs: opts.timeoutMs,
        },
        successMessage: `scrolled into view: ${refValue}`,
      });
    });

  browser
    .command("drag")
    .description("Drag from one ref to another")
    .argument("<startRef>", "Start ref id")
    .argument("<endRef>", "End ref id")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (startRef: string, endRef: string, opts, cmd) => {
      await runElementAction({
        cmd,
        body: {
          kind: "drag",
          startRef,
          endRef,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `dragged ${startRef} → ${endRef}`,
      });
    });

  browser
    .command("select")
    .description("Select option(s) in a select element")
    .argument("<ref>", "Ref id from snapshot")
    .argument("<values...>", "Option values to select")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (ref: string, values: string[], opts, cmd) => {
      await runElementAction({
        cmd,
        body: {
          kind: "select",
          ref,
          values,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `selected ${values.join(", ")}`,
      });
    });

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

  browser
    .command("fill")
    .description("Fill a form with JSON field descriptors")
    .option("--fields <json>", "JSON array of field objects")
    .option("--fields-file <path>", "Read JSON array from a file")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCliCommand(async () => {
        const fields = await readFields({
          fields: opts.fields,
          fieldsFile: opts.fieldsFile,
        });
        await runBrowserAction({
          parent,
          body: {
            kind: "fill",
            fields,
            targetId: normalizeOptionalString(opts.targetId),
          },
          successMessage: `filled ${fields.length} field(s)`,
        });
      });
    });

  browser
    .command("wait")
    .description("Wait for time, selector, URL, load state, or JS conditions")
    .argument("[selector]", "CSS selector to wait for (visible)")
    .option("--time <ms>", "Wait for N milliseconds", (v: string) =>
      parseBrowserNonNegativeIntegerOption(v, "--time"),
    )
    .option("--text <value>", "Wait for text to appear")
    .option("--text-gone <value>", "Wait for text to disappear")
    .option("--url <pattern>", "Wait for URL (supports globs like **/dash)")
    .option("--load <load|domcontentloaded|networkidle>", "Wait for load state")
    .option("--fn <js>", "Wait for JS condition (passed to waitForFunction)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for each condition (default: 20000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (selector: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCliCommand(async () => {
        const load = parseBrowserWaitLoadState(opts.load);
        await runBrowserAction({
          parent,
          body: {
            kind: "wait",
            timeMs: opts.time,
            text: normalizeOptionalString(opts.text),
            textGone: normalizeOptionalString(opts.textGone),
            selector: normalizeOptionalString(selector),
            url: normalizeOptionalString(opts.url),
            loadState: load,
            fn: normalizeOptionalString(opts.fn),
            targetId: normalizeOptionalString(opts.targetId),
            timeoutMs: opts.timeoutMs,
          },
          successMessage: "wait complete",
        });
      });
    });

  browser
    .command("evaluate")
    .description("Evaluate JavaScript against the page or a ref")
    .option(
      "--fn <code>",
      "Function source, expression, or statement body, e.g. const text = el.textContent; return text;",
    )
    .option("--ref <id>", "Ref from snapshot")
    .option(
      "--timeout-ms <ms>",
      "How long to allow the evaluate function to run (default: 20000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      if (!opts.fn) {
        defaultRuntime.error(danger("Missing --fn"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCliCommand(async () => {
        await runBrowserAction({
          parent,
          body: {
            kind: "evaluate",
            fn: opts.fn,
            ref: normalizeOptionalString(opts.ref),
            targetId: normalizeOptionalString(opts.targetId),
            timeoutMs: opts.timeoutMs,
          },
        });
      });
    });

  browser
    .command("batch")
    .description("Run a batch of browser actions in one call (default: stop on first error)")
    .option("--actions <json>", "JSON array of act requests")
    .option("--actions-file <path>", "Read JSON array from a file (- for stdin)")
    .option("--continue", "Continue through all actions instead of stopping on first error")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      if (opts.actions !== undefined && opts.actionsFile !== undefined) {
        defaultRuntime.error(danger("Specify only one of --actions or --actions-file"));
        defaultRuntime.exit(1);
        return;
      }
      if (!opts.actions && !opts.actionsFile) {
        defaultRuntime.error(danger("Provide --actions, --actions-file, or --actions-file -"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCliCommand(async () => {
        const payload = await readActionsPayload({
          actions: opts.actions,
          actionsFile: opts.actionsFile,
        });
        const actions = parseBrowserInputArray(payload, "actions");
        if (!actions.length) {
          throw new Error("actions must contain at least one entry");
        }
        const targetId = normalizeOptionalString(opts.targetId);
        const request = {
          kind: "batch",
          actions,
          ...(targetId ? { targetId } : {}),
          ...(opts.continue ? { stopOnError: false } : {}),
        } as BrowserActRequest; // SAFETY: /act validates children; budgeting tolerates raw entries.
        await runBrowserAction({
          parent,
          body: request,
          successMessage: `batch ran ${actions.length} action(s)`,
        });
      });
    });
}
