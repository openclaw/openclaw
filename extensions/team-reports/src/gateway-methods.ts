import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { describePeriod, periodSchema } from "./periods.js";
import type { TeamReportsScheduler } from "./scheduler.js";
import type { TeamReportsStore } from "./store.js";

const listSchema = z.strictObject({ period: periodSchema.optional() });
const getSchema = z.strictObject({
  period: periodSchema,
  key: z.string(),
  format: z.enum(["json", "markdown"]).default("json"),
});
const generateSchema = z.strictObject({
  period: z.literal("day"),
  date: z.iso.date().optional(),
  intraday: z.boolean().optional(),
});

export function registerTeamReportsGatewayMethods(
  api: OpenClawPluginApi,
  access: {
    scheduler: () => TeamReportsScheduler;
    store: () => TeamReportsStore;
  },
): void {
  const register = (
    name: string,
    scope: "operator.read" | "operator.admin",
    run: (params: unknown) => Promise<unknown>,
  ) => {
    api.registerGatewayMethod(
      `team-reports.${name}`,
      async ({ params, respond }) => {
        try {
          respond(true, await run(params ?? {}));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Team Reports request failed";
          respond(
            false,
            undefined,
            errorShape(
              error instanceof z.ZodError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
              message,
            ),
          );
        }
      },
      { scope },
    );
  };
  register("status", "operator.read", (params) => {
    z.strictObject({}).parse(params);
    return access.scheduler().status();
  });
  register("list", "operator.read", async (params) => ({
    periods: await access.store().listPeriods(listSchema.parse(params)),
  }));
  register("get", "operator.read", async (params) => {
    const { period, key, format } = getSchema.parse(params);
    describePeriod(period, key);
    const stored = await access.store().getPeriod(period, key);
    if (!stored) {
      throw new Error("Report not found; generate the requested UTC day first");
    }
    return format === "markdown"
      ? { markdown: stored.markdown }
      : { report: stored.report, summary: stored.summary };
  });
  register("generate", "operator.admin", async (params) => ({
    runId: await access.scheduler().generate(generateSchema.parse(params)),
  }));
}
