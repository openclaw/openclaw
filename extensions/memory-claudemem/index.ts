import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { claudeMemConfigSchema } from "./config.js";
import { ClaudeMemClient } from "./client.js";

const claudeMemPlugin = {
  id: "memory-claudemem",
  name: "Memory (Claude-Mem)",
  description: "Real-time observation and memory via claude-mem worker",
  kind: "memory" as const,
  configSchema: claudeMemConfigSchema,

  register(api: ClawdbotPluginApi) {
    const cfg = claudeMemConfigSchema.parse(api.pluginConfig);
    const client = new ClaudeMemClient(cfg.workerUrl, cfg.workerTimeout);

    api.logger.info(
      `memory-claudemem: plugin registered (worker: ${cfg.workerUrl})`,
    );

    // Hook: after_tool_call → Observe tool calls (fire-and-forget)
    api.on("after_tool_call", async (event, ctx) => {
      // Skip memory tools to prevent recursion
      if (event.toolName.startsWith("memory_")) return;

      try {
        // Fire-and-forget: don't await, let it run in parallel
        // Use sessionKey as the session identifier (may be undefined)
        client.observe(
          ctx.sessionKey ?? "unknown",
          event.toolName,
          event.params,
          event.result,
        );
      } catch (err) {
        api.logger.warn?.(`memory-claudemem: observation failed: ${err}`);
      }
    });

    // Hook: before_agent_start → Context injection from memory search
    api.on("before_agent_start", async (event) => {
      // Skip if prompt is empty or too short
      if (!event.prompt || event.prompt.length < 5) return;

      try {
        const results = await client.search(event.prompt, 5);
        if (results.length === 0) return;

        const memoryContext = results
          .map((r) => `- [#${r.id}] ${r.title}: ${r.snippet}`)
          .join("\n");

        api.logger.info?.(
          `memory-claudemem: injecting ${results.length} memories into context`,
        );

        return {
          prependContext: `<claude-mem-context>\nThe following memories may be relevant:\n${memoryContext}\n</claude-mem-context>`,
        };
      } catch (err) {
        api.logger.warn?.(`memory-claudemem: context injection failed: ${err}`);
      }
    });

    // Phase 5: Tool registration
    // memory_search - Layer 1: compact results (~50-100 tokens per result)
    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search past observations. Returns compact results with IDs. Use memory_observations for full details.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default: 10)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 10 } = params as {
            query: string;
            limit?: number;
          };

          const results = await client.search(query, limit);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
            };
          }

          const text = results.map((r) => `[#${r.id}] ${r.title}`).join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
          };
        },
      },
      { name: "memory_search" },
    );

    // memory_observations - Layer 3: full details (~500-1000 tokens per result)
    api.registerTool(
      {
        name: "memory_observations",
        label: "Memory Observations",
        description:
          "Get full details for specific observation IDs. Use after memory_search to filter.",
        parameters: Type.Object({
          ids: Type.Array(Type.Number(), {
            description: "Array of observation IDs to fetch",
          }),
        }),
        async execute(_toolCallId, params) {
          const { ids } = params as { ids: number[] };

          if (ids.length === 0) {
            return {
              content: [{ type: "text", text: "No observation IDs provided." }],
            };
          }

          const observations = await client.getObservations(ids);

          if (observations.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No observations found for the given IDs.",
                },
              ],
            };
          }

          const text = observations
            .map((obs) => {
              const filesSection =
                obs.files_modified && obs.files_modified.length > 0
                  ? `\n\nFiles: ${obs.files_modified.join(", ")}`
                  : "";
              return `## #${obs.id}\n${obs.narrative}${filesSection}`;
            })
            .join("\n\n---\n\n");

          return {
            content: [{ type: "text", text }],
          };
        },
      },
      { name: "memory_observations" },
    );

    // Phase 6: CLI registration
    api.registerCli(
      ({ program }) => {
        const claudeMem = program
          .command("claude-mem")
          .description("Claude-mem memory plugin commands");

        claudeMem
          .command("status")
          .description("Check if the claude-mem worker is responding")
          .action(async () => {
            const isHealthy = await client.ping();
            if (isHealthy) {
              console.log(`✓ Worker running at ${cfg.workerUrl}`);
            } else {
              console.log(`✗ Worker not responding at ${cfg.workerUrl}`);
              process.exitCode = 1;
            }
          });

        claudeMem
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "10")
          .action(async (query, opts) => {
            const results = await client.search(query, parseInt(opts.limit));
            console.log(JSON.stringify(results, null, 2));
          });
      },
      { commands: ["claude-mem"] },
    );
  },
};

export default claudeMemPlugin;
