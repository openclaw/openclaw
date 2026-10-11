import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { periodSchema } from "./periods.js";

type CliContext = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0];

function request(method: string, options: GatewayRpcOpts, params: unknown): Promise<unknown> {
  return callGatewayFromCli(`team-reports.${method}`, options, params, {
    mode: "cli",
    scopes: method === "generate" ? ["operator.admin"] : ["operator.read"],
  });
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseCliValue<T>(schema: z.ZodType<T>, value: string, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(message);
  }
  return result.data;
}

export function registerTeamReportsCli({ program }: Pick<CliContext, "program">): void {
  const reports = program
    .command("team-reports")
    .description("Browse and generate team activity reports");
  addGatewayClientOptions(
    reports
      .command("status")
      .description("Show collection status and scheduled runs")
      .option("--json", "Print JSON", false),
  ).action(async (options: GatewayRpcOpts) => {
    writeResult(await request("status", options, {}));
  });
  addGatewayClientOptions(
    reports
      .command("list")
      .description("List stored reports")
      .option("--period <period>", "Filter day, week, or month reports")
      .option("--json", "Print JSON", false),
  ).action(async (options: GatewayRpcOpts & { period?: string }) => {
    writeResult(
      await request(
        "list",
        options,
        options.period
          ? {
              period: parseCliValue(
                periodSchema,
                options.period,
                "--period must be day, week, or month.",
              ),
            }
          : {},
      ),
    );
  });
  addGatewayClientOptions(
    reports
      .command("show")
      .description("Show a stored report")
      .argument("<period>", "day, week, or month")
      .argument("<key>", "Period key")
      .option("--markdown", "Print the report as Markdown", false)
      .option("--json", "Print JSON", false),
  ).action(
    async (period: string, key: string, options: GatewayRpcOpts & { markdown?: boolean }) => {
      const format = options.json && !options.markdown ? "json" : "markdown";
      const result = await request("get", options, {
        period: parseCliValue(periodSchema, period, "<period> must be day, week, or month."),
        key,
        format,
      });
      if (format === "markdown" && !options.json) {
        const { markdown } = z.object({ markdown: z.string() }).parse(result);
        process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
      } else {
        writeResult(result);
      }
    },
  );
  addGatewayClientOptions(
    reports
      .command("generate")
      .description("Start a manual day report run")
      .option("--date <date>", "UTC day in YYYY-MM-DD form")
      .option("--intraday", "Refresh the open UTC day", false)
      .option("--json", "Print JSON", false),
  ).action(async (options: GatewayRpcOpts & { date?: string; intraday?: boolean }) => {
    writeResult(
      await request("generate", options, {
        period: "day",
        ...(options.date
          ? {
              date: parseCliValue(
                z.iso.date(),
                options.date,
                "--date must be a UTC day in YYYY-MM-DD form.",
              ),
            }
          : {}),
        ...(options.intraday ? { intraday: true } : {}),
      }),
    );
  });
}
