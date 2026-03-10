import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/tracing";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/tracing";
import { TraceCollector } from "./src/collector.js";
import { JsonlTraceWriter } from "./src/storage-jsonl.js";
import { renderCallTree, renderEntityTree, renderWaterfall } from "./src/viewer-cli.js";
import { createTracingHttpHandler } from "./src/web-viewer.js";

const plugin = {
  id: "tracing",
  name: "Agent Tracing",
  description: "Trace tool calls, LLM invocations, and sub-agent relationships",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const traceDir = path.join(os.homedir(), ".openclaw", "traces");
    const writer = new JsonlTraceWriter(traceDir);
    const collector = new TraceCollector((span) => writer.write(span));

    api.on("session_start", (event, ctx) => collector.onSessionStart(event, ctx));
    api.on("session_end", (event, ctx) => collector.onSessionEnd(event, ctx));
    api.on("llm_input", (event, ctx) => collector.onLlmInput(event, ctx));
    api.on("llm_output", (event, ctx) => collector.onLlmOutput(event, ctx));
    api.on("before_tool_call", (event, ctx) => {
      collector.onBeforeToolCall(event, ctx);
    });
    api.on("after_tool_call", (event, ctx) => collector.onAfterToolCall(event, ctx));
    api.on("subagent_spawning", (event, ctx) => {
      collector.onSubagentSpawning(event, ctx);
    });
    api.on("subagent_ended", (event, ctx) => collector.onSubagentEnded(event, ctx));

    // Web UI at /plugins/tracing
    api.registerHttpRoute({
      path: "/plugins/tracing",
      auth: "plugin",
      match: "prefix",
      handler: createTracingHttpHandler(writer),
    });

    api.registerCli(
      ({ program }) => {
        program
          .command("traces")
          .description("View agent execution traces")
          .option("--mode <mode>", "View mode: call, entity, waterfall, both", "both")
          .option("--date <date>", "Date to view (YYYY-MM-DD), defaults to today")
          .option("--list", "List available trace dates")
          .action((opts: { mode?: string; date?: string; list?: boolean }) => {
            if (opts.list) {
              const dates = writer.listDates();
              if (!dates.length) {
                console.log("No traces found.");
                return;
              }
              for (const d of dates) console.log(d);
              return;
            }

            const dateKey = opts.date ?? new Date().toISOString().slice(0, 10);
            const spans = writer.readByDate(dateKey);
            if (!spans.length) {
              console.log(`No traces for ${dateKey}.`);
              return;
            }

            const mode = opts.mode ?? "both";
            if (mode === "call" || mode === "both") {
              for (const line of renderCallTree(spans)) console.log(line);
            }
            if (mode === "entity" || mode === "both") {
              for (const line of renderEntityTree(spans)) console.log(line);
            }
            if (mode === "waterfall" || mode === "both") {
              for (const line of renderWaterfall(spans)) console.log(line);
            }
          });
      },
      { commands: ["traces"] },
    );
  },
};

export default plugin;
