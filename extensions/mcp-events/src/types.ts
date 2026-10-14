import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import type { McpEventsConfig } from "./config.js";
import type { McpEventsRuntime } from "./state.js";

type ServiceCron = NonNullable<ReturnType<NonNullable<OpenClawPluginServiceContext["getCron"]>>>;
export type EventSourceSnapshot = Awaited<
  ReturnType<NonNullable<ServiceCron["readEventSources"]>>
>[number];
export type EventCron = Required<Pick<ServiceCron, "readEventSources" | "runEvent">>;
export type McpEventsDependencies = {
  runtime: McpEventsRuntime;
  config: McpEventsConfig;
  scheduler: Pick<
    NonNullable<OpenClawPluginServiceContext["scheduler"]>,
    "signal" | "now" | "schedule"
  >;
  cron: EventCron;
  prepareSource: NonNullable<OpenClawPluginServiceContext["mcpEvents"]>["prepareSource"];
  logger: OpenClawPluginServiceContext["logger"];
};
