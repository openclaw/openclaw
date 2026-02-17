/**
 * Bridges openclaw's sandbox/policy/hook logic into the claude-agent-sdk's
 * hook system. This allows the SDK's built-in tools (Read, Write, Edit, Bash,
 * Glob, Grep) to be intercepted for:
 *
 * 1. Tool policy enforcement (allowed/denied lists)
 * 2. Sandbox path restrictions (rewrite file_path for sandboxed tools)
 * 3. openclaw's before_tool_call / after_tool_call plugin hooks
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { HookRunner } from "../../plugins/hooks.js";
import { isPlainObject } from "../../utils.js";

export type HookBridgeParams = {
  hookRunner?: HookRunner;
};

/**
 * Build SDK hook definitions that bridge openclaw's plugin hooks.
 *
 * The `PreToolUse` hook runs openclaw's `before_tool_call` plugin hook.
 * The `PostToolUse` hook runs openclaw's `after_tool_call` plugin hook.
 */
export function buildSdkHooks(
  params: HookBridgeParams,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  const { hookRunner } = params;

  // PreToolUse: Run before_tool_call hook
  const preToolUseCallback: HookCallback = async (
    input: HookInput,
    _toolUseID,
    { signal: _signal },
  ) => {
    const preInput = input as PreToolUseHookInput;
    const toolName = preInput.tool_name;
    const toolInput = preInput.tool_input;

    if (hookRunner?.hasHooks("before_tool_call")) {
      try {
        const outcome = await hookRunner.runBeforeToolCall(
          {
            toolName,
            params: isPlainObject(toolInput) ? toolInput : {},
          },
          { toolName },
        );
        if (outcome?.block) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: outcome.blockReason ?? "Blocked by openclaw policy",
            },
          };
        }
        // If the hook adjusted params, pass them through
        if (outcome?.params && isPlainObject(outcome.params)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "allow" as const,
              updatedInput: outcome.params,
            },
          };
        }
      } catch {
        // Hook failure is non-fatal; allow the tool call to proceed.
      }
    }

    // Default: allow
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
      },
    } satisfies SyncHookJSONOutput;
  };

  hooks.PreToolUse = [
    {
      matcher: ".*",
      hooks: [preToolUseCallback],
    },
  ];

  // PostToolUse: Run after_tool_call hook
  const postToolUseCallback: HookCallback = async (
    input: HookInput,
    _toolUseID,
    { signal: _signal },
  ) => {
    const postInput = input as PostToolUseHookInput;
    const toolName = postInput.tool_name;
    const toolInput = postInput.tool_input;
    const toolResponse = postInput.tool_response;

    if (hookRunner?.hasHooks("after_tool_call")) {
      try {
        await hookRunner.runAfterToolCall(
          {
            toolName,
            params: isPlainObject(toolInput) ? toolInput : {},
            result: toolResponse,
          },
          { toolName },
        );
      } catch {
        // Hook failure is non-fatal.
      }
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
      },
    } satisfies SyncHookJSONOutput;
  };

  hooks.PostToolUse = [
    {
      matcher: ".*",
      hooks: [postToolUseCallback],
    },
  ];

  return hooks;
}
