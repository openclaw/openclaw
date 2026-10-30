import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { readStringArrayParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { CodexGeneratedMediaProjection } from "./event-projector-media.js";

/** Tool construction precedes the native turn and its media projection. */
export class CodexGeneratedMediaToolBinding {
  current?: CodexGeneratedMediaProjection;
}

export function createCodexGeneratedMediaTool(
  context: OpenClawPluginToolContext<2>,
): AnyAgentTool | undefined {
  const binding = context.toolBindings?.codexGeneratedMedia;
  if (!(binding instanceof CodexGeneratedMediaToolBinding)) {
    return undefined;
  }
  return {
    name: "generated_media",
    label: "Generated Media",
    description:
      "List this Codex turn's generated images or discard unwanted candidates from automatic final delivery. List first to obtain itemIds and paths. Discard is explicit and does not delete files, undo sends, or affect other images. Without discard, all unsent images remain eligible for delivery.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("list"), Type.Literal("discard")]),
        itemIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      },
      { additionalProperties: false },
    ),
    async execute(_callId, rawParams) {
      context.assertInvocationCurrent();
      const media = binding.current;
      if (!media) {
        throw new Error("Generated media is unavailable outside the active Codex turn.");
      }
      const params = asNonArrayRecord(rawParams);
      const action = readStringParam(params, "action", { required: true });
      if (action === "discard") {
        const itemIds = readStringArrayParam(params, "itemIds", { required: true });
        media.discard(itemIds);
      } else if (action !== "list") {
        throw new Error(`Unknown generated media action: ${action}`);
      }
      return jsonResult({ images: media.list() });
    },
  };
}
