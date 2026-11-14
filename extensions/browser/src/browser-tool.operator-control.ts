import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { resolveProfile } from "./browser/config.js";
import {
  BROWSER_OPERATOR_CONTROL_MESSAGE,
  readBrowserOperatorActivity,
} from "./browser/operator-control.js";

/**
 * How the browser tool reports operator take-over (see browser/operator-control.ts): a take-over
 * is a pause, not a failure, so the agent's turn continues with a normal result.
 */

const RECENT_OPERATOR_INPUT_MS = 60_000;

/** Answer a refused action with the take-over result; rethrow anything else. */
export function userHasControlResult(error: unknown): AgentToolResult<unknown> {
  if (!String(error).includes(BROWSER_OPERATOR_CONTROL_MESSAGE)) {
    throw error;
  }
  return jsonResult({
    status: "user_has_control",
    message:
      "The user has taken over this browser in the Browser panel, so this action was not run. Continue with other work or tell the user what you still need in the browser. You can try again once they release control; it is released automatically after 5 minutes without input.",
  });
}

/** Tell the agent when the user is using the same browser, without blocking anything. */
export async function withOperatorActivityNote(
  result: AgentToolResult<unknown>,
  profile: string,
): Promise<AgentToolResult<unknown>> {
  const { getBrowserControlState } = await import("./browser-control-state.js");
  const state = getBrowserControlState();
  // Resolve against the running config so the note keys on the same browser as the routes.
  const resolved = state ? resolveProfile(state.resolved, profile) : null;
  const activity = state && resolved ? readBrowserOperatorActivity(state, resolved) : undefined;
  const idleFor = activity?.lastOperatorInputAt
    ? Date.now() - activity.lastOperatorInputAt
    : undefined;
  const note = activity?.controlled
    ? "Note: the user has taken over this browser in the Browser panel. You can look, but actions wait until they release control."
    : idleFor !== undefined && idleFor < RECENT_OPERATOR_INPUT_MS
      ? `Note: the user used this browser from the Browser panel ${Math.round(idleFor / 1000)} seconds ago. Check the page before acting on it.`
      : undefined;
  return note ? { ...result, content: [...result.content, { type: "text", text: note }] } : result;
}
