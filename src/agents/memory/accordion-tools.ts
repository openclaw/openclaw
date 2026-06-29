/**
 * Agent accordion tools (Phase 2, 02-03): `expand_topic` / `collapse_topic` let the
 * model manually override the auto-collapse rule for a named topic box. Both flip
 * `boxes.state` only (never mutate turns) via the manual-override path, so an expand
 * holds until the topic genuinely moves on (see setBoxStateManual / active-tag-set).
 * Created with the run's agentId + sessionKey captured at construction time and wired
 * into createOpenClawTools only when conversationalMemory is enabled.
 */
import type { AnyAgentTool } from "../tools/common.js";
import { asToolParamsRecord, jsonResult } from "../tools/common.js";
import { listBoxes, setBoxStateManual, type BoxState } from "./turns-store.js";

const TopicSchema = {
  type: "object",
  required: ["topic"],
  properties: {
    topic: {
      type: "string",
      description: "The topic box id or label to toggle (case-insensitive match on label).",
    },
  },
} satisfies Record<string, unknown>;

/** Resolve a box by exact id or case-insensitive label within the session. */
function resolveBoxId(
  scope: { agentId: string; sessionKey: string },
  topic: string,
): string | null {
  const wanted = topic.trim();
  if (!wanted) {
    return null;
  }
  const boxes = listBoxes(scope);
  const byId = boxes.find((box) => box.box_id === wanted);
  if (byId) {
    return byId.box_id;
  }
  const lower = wanted.toLowerCase();
  const byLabel = boxes.find((box) => (box.label ?? "").toLowerCase() === lower);
  return byLabel?.box_id ?? null;
}

function makeAccordionTool(
  scope: { agentId: string; sessionKey: string },
  spec: { name: string; label: string; description: string; state: BoxState },
): AnyAgentTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: TopicSchema,
    execute: async (_toolCallId, args) => {
      const topic = String(asToolParamsRecord(args).topic ?? "");
      const boxId = resolveBoxId(scope, topic);
      if (boxId == null) {
        return jsonResult({ ok: false, error: `No topic box matched "${topic}".` });
      }
      const changed = setBoxStateManual({ ...scope, boxId, state: spec.state });
      return jsonResult({ ok: changed, boxId, state: spec.state });
    },
  };
}

/** Build the `expand_topic` / `collapse_topic` tools for a run scope. */
export function createAccordionTools(scope: {
  agentId: string;
  sessionKey: string;
}): AnyAgentTool[] {
  return [
    makeAccordionTool(scope, {
      name: "expand_topic",
      label: "Expand Topic",
      description:
        "Re-expand a collapsed topic so its full turns return to context. Overrides the " +
        "automatic collapse until the conversation moves to a different topic.",
      state: "live",
    }),
    makeAccordionTool(scope, {
      name: "collapse_topic",
      label: "Collapse Topic",
      description:
        "Collapse a topic to its summary, freeing context. The full turns are preserved " +
        "and can be expanded again later.",
      state: "collapsed",
    }),
  ];
}
