import { Type } from "@sinclair/typebox";
import type { CcRelayDispatcher } from "./dispatcher.js";

/**
 * Agent tool schema for `cc_dispatch`.
 *
 * This tool allows an OpenClaw agent to dispatch a task to Claude Code CLI.
 * The agent provides the user's prompt verbatim, and the relay handles
 * background execution, progress reporting, and result delivery.
 */
const CcDispatchSchema = Type.Object(
  {
    prompt: Type.String({
      description:
        "The user's message to forward to Claude Code, verbatim. Do not modify, summarize, or augment the user's words.",
    }),
    task_name: Type.Optional(
      Type.String({
        description:
          "A short label for the task (2-4 words). Used in progress messages.",
      }),
    ),
    fresh: Type.Optional(
      Type.Boolean({
        description:
          'Start a new Claude Code session instead of continuing the previous one. Default: false. Set to true when the user says "new session" or the topic changes significantly.',
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Create the cc_dispatch tool.
 *
 * `channel` and `target` are captured from the tool factory context at registration
 * time, so the execute function only receives the standard `(toolCallId, rawParams)`.
 */
export function createCcDispatchTool(
  getDispatcher: () => CcRelayDispatcher | null,
  channel: string,
  target: string,
) {
  return {
    name: "cc_dispatch",
    label: "Claude Code Dispatch",
    description:
      "Dispatch a task to Claude Code CLI for execution. The task runs in the background; " +
      "progress updates and final results are automatically sent back to the current channel. " +
      "Use this tool to forward the user's request to Claude Code instead of answering directly.",
    parameters: CcDispatchSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const dispatcher = getDispatcher();
      if (!dispatcher) {
        return {
          content: [
            {
              type: "text" as const,
              text: "cc-relay plugin is not active. Check plugin configuration.",
            },
          ],
        };
      }

      const prompt = String(rawParams.prompt ?? "");
      if (!prompt.trim()) {
        return {
          content: [{ type: "text" as const, text: "Error: prompt is required." }],
        };
      }

      const taskName = rawParams.task_name ? String(rawParams.task_name) : undefined;
      const fresh = rawParams.fresh === true;

      const job = dispatcher.dispatch({
        prompt,
        taskName,
        channel,
        target,
        fresh,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Task dispatched: ${job.taskName} (id: ${job.id}). ` +
              `Results will be sent to the channel when complete.` +
              (fresh ? " (new session)" : " (continuing session)"),
          },
        ],
      };
    },
  };
}
