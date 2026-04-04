import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../api.js";
import { getItems, sendCommand, getVariables, type C4Item } from "./client.js";

const STRUCTURAL_TYPES = new Set(["root", "site", "building", "floor", "room"]);

function isControllable(item: C4Item): boolean {
  return !STRUCTURAL_TYPES.has(item.typeName);
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "the", "my", "all", "and", "or", "is", "in", "on", "at",
  "to", "for", "of", "off", "turn", "set", "get", "show", "tell", "with",
]);

function itemMatchesQuery(item: C4Item, query: string): boolean {
  // Split the query into meaningful tokens; each token is OR-ed across fields.
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !QUERY_STOP_WORDS.has(t));

  if (terms.length === 0) return true;

  const name = item.name.toLowerCase();
  const room = (item.roomName ?? "").toLowerCase();
  const type = item.typeName.toLowerCase();
  const haystack = `${name} ${room} ${type}`;
  return terms.some((term) => haystack.includes(term));
}

/** Tool 1: Find devices by name, room, or type. */
export function createFindTool(): AnyAgentTool {
  return {
    name: "control4_find",
    label: "Control4 Find",
    description:
      "Find Control4 devices by free-text query, room name, or device type. Returns device IDs needed for control4_command and control4_status.",
    parameters: Type.Object(
      {
        query: Type.String({
          description:
            'Free-text search — matched against device name, room name, and type (e.g. "living room lights", "thermostat", "lock").',
        }),
        roomName: Type.Optional(
          Type.String({ description: "Filter to devices in this room (case-insensitive)." }),
        ),
        deviceType: Type.Optional(
          Type.String({
            description:
              'Filter by device type keyword (e.g. "light", "thermostat", "lock", "dimmer").',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        query: string;
        roomName?: string;
        deviceType?: string;
      };

      const items = await getItems();
      const controllable = items.filter(isControllable);

      let matches = controllable.filter((item) => itemMatchesQuery(item, params.query));

      if (params.roomName) {
        const rn = params.roomName.toLowerCase();
        matches = matches.filter((item) => (item.roomName ?? "").toLowerCase().includes(rn));
      }

      if (params.deviceType) {
        const dt = params.deviceType.toLowerCase();
        matches = matches.filter((item) => item.typeName.toLowerCase().includes(dt));
      }

      const results = matches.map((item) => ({
        id: item.id,
        name: item.name,
        room: item.roomName ?? "Unknown",
        type: item.typeName,
      }));

      return {
        content: [
          {
            type: "text",
            text:
              results.length === 0
                ? "No matching devices found."
                : `Found ${results.length} device(s):\n${results.map((r) => `  [${r.id}] ${r.name} (${r.type}) — ${r.room}`).join("\n")}`,
          },
        ],
        details: { count: results.length, devices: results },
      };
    },
  };
}

/** Tool 2: Send a command to one or more devices. */
export function createCommandTool(): AnyAgentTool {
  return {
    name: "control4_command",
    label: "Control4 Command",
    description:
      "Send a command to one or more Control4 devices. Use control4_find first to get device IDs.",
    parameters: Type.Object(
      {
        deviceIds: Type.Array(Type.Number({ description: "Device ID from control4_find." }), {
          description: "List of device IDs to send the command to.",
          minItems: 1,
        }),
        command: Type.Unsafe<
          "ON" | "OFF" | "RAMP_TO_LEVEL" | "SET_SCALE" | "SET_HVAC_MODE" | string
        >({
          type: "string",
          description:
            'Command name. Common values: "ON", "OFF", "RAMP_TO_LEVEL" (lights, needs LEVEL param), "SET_SCALE" (lights, needs SCALE param 0-100), "SET_HVAC_MODE" (thermostats).',
        }),
        params: Type.Optional(
          Type.Object(
            {
              LEVEL: Type.Optional(
                Type.String({ description: 'Light level 0–100 for RAMP_TO_LEVEL.' }),
              ),
              SCALE: Type.Optional(
                Type.String({ description: 'Light scale 0–100 for SET_SCALE.' }),
              ),
              MODE: Type.Optional(
                Type.String({
                  description: 'HVAC mode for SET_HVAC_MODE (e.g. "COOL", "HEAT", "AUTO", "OFF").',
                }),
              ),
            },
            { additionalProperties: true },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        deviceIds: number[];
        command: string;
        params?: Record<string, string>;
      };

      const results: Array<{ id: number; success: boolean; error?: string }> = [];

      for (const deviceId of params.deviceIds) {
        try {
          await sendCommand(deviceId, params.command, params.params);
          results.push({ id: deviceId, success: true });
        } catch (err) {
          results.push({
            id: deviceId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;

      const lines = results.map((r) =>
        r.success
          ? `  [${r.id}] ✓ ${params.command} sent`
          : `  [${r.id}] ✗ Failed: ${r.error}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Command "${params.command}" sent to ${params.deviceIds.length} device(s): ${succeeded} succeeded, ${failed} failed.\n${lines.join("\n")}`,
          },
        ],
        details: { command: params.command, results, succeeded, failed },
      };
    },
  };
}

/** Tool 3: Query current variable state for devices. */
export function createStatusTool(): AnyAgentTool {
  return {
    name: "control4_status",
    label: "Control4 Status",
    description:
      "Query the current state (variables) of Control4 devices — e.g. light level, temperature, lock state.",
    parameters: Type.Object(
      {
        deviceIds: Type.Array(Type.Number({ description: "Device ID from control4_find." }), {
          description: "List of device IDs to query.",
          minItems: 1,
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { deviceIds: number[] };

      const results: Array<{
        id: number;
        variables?: Array<{ name: string; value: string | number | boolean }>;
        error?: string;
      }> = [];

      for (const deviceId of params.deviceIds) {
        try {
          const vars = await getVariables(deviceId);
          results.push({
            id: deviceId,
            variables: vars.map((v) => ({ name: v.name, value: v.value })),
          });
        } catch (err) {
          results.push({
            id: deviceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const lines = results.map((r) => {
        if (r.error) return `  [${r.id}] Error: ${r.error}`;
        if (!r.variables || r.variables.length === 0) return `  [${r.id}] No variables`;
        const varLines = r.variables.map((v) => `    ${v.name}: ${v.value}`).join("\n");
        return `  [${r.id}]\n${varLines}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Status for ${params.deviceIds.length} device(s):\n${lines.join("\n")}`,
          },
        ],
        details: { results },
      };
    },
  };
}
