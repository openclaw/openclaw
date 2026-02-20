import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { DoltReadOnlyQueryHelpers } from "../read-only-dolt-store.js";
import { buildNoContextDataMessage, buildScaffoldMessage } from "./common.js";

/**
 * Build the scaffolded dolt_describe tool.
 */
export function createDoltDescribeTool(params: {
  queries: DoltReadOnlyQueryHelpers;
}): AnyAgentTool {
  return {
    name: "dolt_describe",
    label: "Dolt Describe",
    description:
      "Inspect what a Dolt pointer refers to, including lane metadata and lineage context.",
    parameters: Type.Object({
      pointer: Type.String({ description: "Dolt pointer to inspect (turn/leaf/bindle)." }),
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
            text: `${buildScaffoldMessage("dolt_describe")} Pointer queued: ${pointer}`,
          },
        ],
        details: { pointer, availability },
      };
    },
  };
}
