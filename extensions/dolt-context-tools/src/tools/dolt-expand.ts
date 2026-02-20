import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { DoltReadOnlyQueryHelpers } from "../read-only-dolt-store.js";
import { buildNoContextDataMessage, buildScaffoldMessage } from "./common.js";

/**
 * Build the scaffolded dolt_expand tool.
 */
export function createDoltExpandTool(params: { queries: DoltReadOnlyQueryHelpers }): AnyAgentTool {
  return {
    name: "dolt_expand",
    label: "Dolt Expand",
    description: "Expand a Dolt leaf or bindle pointer into its child records.",
    parameters: Type.Object({
      pointer: Type.String({ description: "Leaf or bindle pointer to expand." }),
    }),
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const pointer = typeof rawParams.pointer === "string" ? rawParams.pointer.trim() : "";
      if (!pointer) {
        throw new Error("pointer required");
      }

      const availability = params.queries.getAvailability();
      if (!availability.available) {
        return {
          content: [{ type: "text", text: buildNoContextDataMessage(availability) }],
          details: { pointer, availability },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `${buildScaffoldMessage("dolt_expand")} Pointer queued: ${pointer}`,
          },
        ],
        details: { pointer, availability },
      };
    },
  };
}
