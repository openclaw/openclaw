import type { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { shortenHomePath } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  BROWSER_TAB_REFERENCE_HELP,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";

function resolveDebugQuery(params: { targetId?: unknown; clear?: unknown; filter?: unknown }) {
  return {
    targetId: normalizeOptionalString(params.targetId),
    filter: normalizeOptionalString(params.filter),
    clear: Boolean(params.clear),
  };
}

export function registerBrowserDebugCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("highlight")
    .description("Highlight an element by ref")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (ref: string, opts, cmd) => {
      await runBrowserCliRequest({
        parent: parentOpts(cmd),
        path: "/highlight",
        body: {
          ref: ref.trim(),
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `highlighted ${ref.trim()}`,
      });
    });

  browser
    .command("errors")
    .description("Get recent page errors")
    .option("--clear", "Clear stored errors after reading", false)
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      await runBrowserCliRequest<{
        errors: Array<{ timestamp: string; name?: string; message: string }>;
      }>({
        parent: parentOpts(cmd),
        method: "GET",
        path: "/errors",
        query: resolveDebugQuery({
          targetId: opts.targetId,
          clear: opts.clear,
        }),
        print: (result) => {
          if (!result.errors.length) {
            defaultRuntime.log("No page errors.");
            return;
          }
          defaultRuntime.log(
            result.errors
              .map((e) => `${e.timestamp} ${e.name ? `${e.name}: ` : ""}${e.message}`)
              .join("\n"),
          );
        },
      });
    });

  browser
    .command("requests")
    .description("Get recent network requests (best-effort)")
    .option("--filter <text>", "Only show URLs that contain this substring")
    .option("--clear", "Clear stored requests after reading", false)
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      await runBrowserCliRequest<{
        requests: Array<{
          timestamp: string;
          method: string;
          status?: number;
          ok?: boolean;
          url: string;
          failureText?: string;
        }>;
      }>({
        parent: parentOpts(cmd),
        method: "GET",
        path: "/requests",
        query: resolveDebugQuery({
          targetId: opts.targetId,
          filter: opts.filter,
          clear: opts.clear,
        }),
        print: (result) => {
          if (!result.requests.length) {
            defaultRuntime.log("No requests recorded.");
            return;
          }
          defaultRuntime.log(
            result.requests
              .map((r) => {
                const status = typeof r.status === "number" ? ` ${r.status}` : "";
                const ok = r.ok === true ? " ok" : r.ok === false ? " fail" : "";
                const fail = r.failureText ? ` (${r.failureText})` : "";
                return `${r.timestamp} ${r.method}${status}${ok} ${r.url}${fail}`;
              })
              .join("\n"),
          );
        },
      });
    });

  const trace = browser.command("trace").description("Record a Playwright trace");

  trace
    .command("start")
    .description("Start trace recording")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option("--no-screenshots", "Disable screenshots")
    .option("--no-snapshots", "Disable snapshots")
    .option("--sources", "Include sources (bigger traces)", false)
    .action(async (opts, cmd) => {
      await runBrowserCliRequest({
        parent: parentOpts(cmd),
        path: "/trace/start",
        body: {
          targetId: normalizeOptionalString(opts.targetId),
          screenshots: Boolean(opts.screenshots),
          snapshots: Boolean(opts.snapshots),
          sources: Boolean(opts.sources),
        },
        successMessage: "trace started",
      });
    });

  trace
    .command("stop")
    .description("Stop trace recording and write a .zip")
    .option(
      "--out <path>",
      "Output path within openclaw temp dir (e.g. trace.zip or /tmp/openclaw/trace.zip)",
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      await runBrowserCliRequest<{ path: string }>({
        parent: parentOpts(cmd),
        path: "/trace/stop",
        body: {
          targetId: normalizeOptionalString(opts.targetId),
          path: normalizeOptionalString(opts.out),
        },
        successMessage: (result) => `TRACE:${shortenHomePath(result.path)}`,
      });
    });
}
