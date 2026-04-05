import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { buildControl4Prompt, getItems, getVariables, sendCommand } from "../c4.js";
import { getCurrentState, triggerPoll } from "../poller.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = join(
  __dirname,
  "../../../extensions/control4/skills/control4/SKILL.md",
);

let skillMdContent: string | null = null;
function getSkillMd(): string {
  if (!skillMdContent) {
    try {
      skillMdContent = readFileSync(SKILL_MD_PATH, "utf8");
    } catch {
      skillMdContent = "";
    }
  }
  return skillMdContent;
}

const client = new Anthropic();

// Tool schemas for Claude
const TOOLS: Anthropic.Tool[] = [
  {
    name: "control4_find",
    description:
      "Find Control4 devices by free-text query, room name, or device type. Returns device IDs needed for control4_command and control4_status.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Free-text search — matched against device name, room name, and type." },
        roomName: { type: "string", description: "Filter to devices in this room (case-insensitive)." },
        deviceType: { type: "string", description: "Filter by device type keyword (e.g. 'light', 'thermostat', 'lock', 'dimmer')." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "control4_command",
    description:
      "Send a command to one or more Control4 devices. Use control4_find first to get device IDs.",
    input_schema: {
      type: "object" as const,
      properties: {
        deviceIds: {
          type: "array",
          items: { type: "number" },
          description: "List of device IDs to send the command to.",
          minItems: 1,
        },
        command: { type: "string", description: 'Command name. Common values: "ON", "OFF", "RAMP_TO_LEVEL", "SET_HVAC_MODE".' },
        params: {
          type: "object",
          description: "Optional command parameters.",
          additionalProperties: true,
        },
      },
      required: ["deviceIds", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "control4_status",
    description:
      "Query the current state (variables) of Control4 devices — e.g. light level, temperature, lock state.",
    input_schema: {
      type: "object" as const,
      properties: {
        deviceIds: {
          type: "array",
          items: { type: "number" },
          description: "List of device IDs to query.",
          minItems: 1,
        },
      },
      required: ["deviceIds"],
      additionalProperties: false,
    },
  },
];

// Simple find implementation for NL route
const STRUCTURAL_TYPES = new Set(["root", "site", "building", "floor", "room"]);
const STOP_WORDS = new Set(["a", "an", "the", "my", "all", "and", "or", "is", "in", "on", "at", "to", "for", "of", "off", "turn", "set", "get", "show", "tell", "with"]);

async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (name === "control4_find") {
    const items = await getItems();
    const query = String(input["query"] ?? "").toLowerCase();
    const roomFilter = input["roomName"] ? String(input["roomName"]).toLowerCase() : null;
    const typeFilter = input["deviceType"] ? String(input["deviceType"]).toLowerCase() : null;

    const tokens = query.split(/\s+/).filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    const terms = [...new Set(tokens.flatMap((t) => [t, t.endsWith("s") && t.length > 3 ? t.slice(0, -1) : t]))];

    let matches = items.filter((item) => !STRUCTURAL_TYPES.has(item.typeName));
    if (terms.length > 0) {
      matches = matches.filter((item) => {
        const hay = `${item.name} ${item.roomName ?? ""} ${item.typeName}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
    }
    if (roomFilter) {
      matches = matches.filter((item) => (item.roomName ?? "").toLowerCase().includes(roomFilter));
    }
    if (typeFilter) {
      matches = matches.filter((item) => item.typeName.toLowerCase().includes(typeFilter));
    }

    const results = matches.map((r) => `[${r.id}] ${r.name} (${r.typeName}) — ${r.roomName ?? "Unknown"}`);
    return results.length === 0
      ? "No matching devices found."
      : `Found ${results.length} device(s):\n${results.join("\n")}`;
  }

  if (name === "control4_command") {
    const deviceIds = input["deviceIds"] as number[];
    const command = String(input["command"]);
    const params = input["params"] as Record<string, string> | undefined;
    const results: string[] = [];
    for (const id of deviceIds) {
      try {
        await sendCommand(id, command, params);
        results.push(`[${id}] ✓ ${command} sent`);
      } catch (err) {
        results.push(`[${id}] ✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return results.join("\n");
  }

  if (name === "control4_status") {
    const deviceIds = input["deviceIds"] as number[];
    const results: string[] = [];
    for (const id of deviceIds) {
      try {
        const vars = await getVariables(id);
        const varLines = vars.map((v) => `  ${v.name}: ${v.value}`).join("\n");
        results.push(`[${id}]\n${varLines || "  (no variables)"}`);
      } catch (err) {
        results.push(`[${id}] Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return results.join("\n");
  }

  return `Unknown tool: ${name}`;
}

export const nlRouter = Router();

nlRouter.post("/nl", async (req, res) => {
  const { message } = req.body as { message: string };
  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const [deviceInventory, currentState] = await Promise.all([
      buildControl4Prompt(),
      Promise.resolve(getCurrentState()),
    ]);

    const stateContext = currentState
      ? `\n\n## Current State Snapshot\nFetched at: ${new Date(currentState.fetchedAt).toLocaleTimeString()}\n` +
        currentState.rooms
          .map((r) => {
            const parts: string[] = [`${r.name}:`];
            const onLights = r.lights.filter((l) => l.on);
            if (r.lights.length > 0) {
              parts.push(
                `  Lights: ${onLights.length}/${r.lights.length} on` +
                  (onLights.length > 0
                    ? ` (${onLights.map((l) => `${l.name} @ ${l.level}%`).join(", ")})`
                    : ""),
              );
            }
            if (r.thermostats.length > 0) {
              parts.push(
                r.thermostats.map((t) =>
                  `  Thermostat ${t.name}: ${t.tempF != null ? `${t.tempF}°F` : "?"} / mode: ${t.hvacMode ?? "?"} / heat: ${t.heatSetpointF ?? "?"}°F / cool: ${t.coolSetpointF ?? "?"}°F`,
                ).join("\n"),
              );
            }
            if (r.locks.length > 0) {
              parts.push(
                r.locks.map((l) =>
                  `  Lock ${l.name}: ${l.locked === true ? "locked" : l.locked === false ? "unlocked" : "unknown"}`,
                ).join("\n"),
              );
            }
            return parts.join("\n");
          })
          .join("\n")
      : "";

    const systemPrompt = [
      deviceInventory,
      stateContext,
      "\n\n---\n",
      getSkillMd(),
    ].join("");

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: message },
    ];

    const commandsExecuted: Array<{ tool: string; input: unknown; result: string }> = [];
    let reply = "";

    // Agentic loop
    for (let turn = 0; turn < 10; turn++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const textBlocks = response.content.filter((b) => b.type === "text");

      if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
        reply = textBlocks.map((b) => (b as Anthropic.TextBlock).text).join("\n");
        break;
      }

      // Execute tools
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const tb = block as Anthropic.ToolUseBlock;
        const result = await executeTool(tb.name, tb.input as Record<string, unknown>);
        commandsExecuted.push({ tool: tb.name, input: tb.input, result });
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Trigger a state refresh after NL commands
    if (commandsExecuted.some((c) => c.tool === "control4_command")) {
      triggerPoll().catch((err) => console.error("[nl] triggerPoll error:", err));
    }

    res.json({ reply, commandsExecuted });
  } catch (err) {
    console.error("[nl] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
