import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import {
  createFileGoalStore,
  GOAL_STATUSES,
  isGoalStatus,
  type GoalStatus,
  type GoalStore,
} from "./state.js";
import { applyGoalStatus } from "./workflow.js";

type GoalStatusToolDeps = {
  store?: GoalStore;
};

const GoalStatusToolSchema = Type.Object(
  {
    status: Type.Unsafe<GoalStatus>({
      type: "string",
      enum: [...GOAL_STATUSES],
      description: "Goal status after this turn.",
    }),
    note: Type.Optional(
      Type.String({ description: "Brief evidence, blocker, or next-step note." }),
    ),
  },
  { additionalProperties: false },
);

export function createGoalStatusTool(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  deps: GoalStatusToolDeps = {},
): AnyAgentTool | null {
  const sessionKey =
    typeof ctx.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey : undefined;
  if (!sessionKey) {
    return null;
  }
  const store =
    deps.store ?? createFileGoalStore({ stateDir: api.runtime.state.resolveStateDir() });
  return {
    name: "goal_status",
    label: "Goal Status",
    description:
      "Report progress for the current session goal. Use continue only when another bounded same-session turn is needed.",
    parameters: GoalStatusToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const params =
        rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {};
      if (!isGoalStatus(params.status)) {
        return jsonResult({ ok: false, error: "status must be a supported goal status" });
      }
      const state = await store.read(sessionKey);
      if (!state) {
        return jsonResult({ ok: false, error: "no active goal for this session" });
      }
      if (params.status === "continue" && state.status !== "continue") {
        return jsonResult({
          ok: false,
          error: `goal is ${state.status}; only /goal resume can reopen a stopped goal`,
        });
      }
      const next = await applyGoalStatus({
        store,
        workflow: api.session.workflow,
        session: ctx,
        state,
        status: params.status,
        note: typeof params.note === "string" ? params.note.trim() || undefined : undefined,
      });
      return jsonResult({ ok: true, goal: next });
    },
  };
}
