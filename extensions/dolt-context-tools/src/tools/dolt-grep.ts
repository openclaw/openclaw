import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { DoltReadOnlyQueryHelpers } from "../read-only-dolt-store.js";
import { buildNoContextDataMessage, buildScaffoldMessage } from "./common.js";

/**
 * Build the scaffolded dolt_grep tool.
 */
export function createDoltGrepTool(params: { queries: DoltReadOnlyQueryHelpers }): AnyAgentTool {
  return {
    name: "dolt_grep",
    label: "Dolt Grep",
    description: "Run regex search against raw turn payloads in the Dolt store.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex pattern to search for." }),
      session_id: Type.String({ description: "Session id to search." }),
      parent_pointer: Type.Optional(
        Type.String({ description: "Optional leaf/bindle pointer scope." }),
      ),
      page: Type.Optional(Type.Number({ description: "1-indexed page number." })),
    }),
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const pattern = typeof rawParams.pattern === "string" ? rawParams.pattern.trim() : "";
      if (!pattern) {
        throw new Error("pattern required");
      }

      const sessionId = typeof rawParams.session_id === "string" ? rawParams.session_id.trim() : "";
      if (!sessionId) {
        throw new Error("session_id required");
      }

      const availability = params.queries.getAvailability();
      if (!availability.available) {
        return {
          content: [{ type: "text", text: buildNoContextDataMessage(availability) }],
          details: { pattern, sessionId, availability },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `${buildScaffoldMessage("dolt_grep")} Pattern queued: ${pattern}`,
          },
        ],
        details: { pattern, sessionId, availability },
      };
    },
  };
}
