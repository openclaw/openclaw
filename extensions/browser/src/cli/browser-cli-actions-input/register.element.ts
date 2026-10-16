import type { Command } from "commander";
import { danger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserActRequest } from "../../browser/client-actions.types.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliCommand,
  parseBrowserNonNegativeIntegerOption,
  parseBrowserPositiveIntegerOption,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";
import { runBrowserAction, requireRef } from "./shared.js";

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

export function registerBrowserElementCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
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
}
