import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { Value } from "typebox/value";

const parameters = Type.Object(
  {
    focus: Type.Optional(
      Type.String({ description: "What the continuation should retain.", maxLength: 800 }),
    ),
  },
  { additionalProperties: false },
);
const description =
  "Request compaction of earlier conversation when a substantial step is complete, " +
  "the direction changes, or a shorter working context would help. " +
  "Include what the continuation must retain: unresolved requests, decisions, and necessary references. " +
  "Continue the task; the host attempts compaction at the next safe tool boundary.";

export default defineToolPlugin({
  id: "session-compaction",
  name: "Session Compaction",
  description: "Let the model request host-owned compaction at useful conversation boundaries.",
  tools: (tool) => [
    tool({
      name: "session_compact",
      label: "Compact Session",
      description,
      parameters,
      optional: true,
      workspaceAccess: false,
      factory: ({ toolContext }) => {
        const capability = toolContext.sessionCompaction;
        if (!capability) {
          return null;
        }
        return {
          name: "session_compact",
          label: "Compact Session",
          description,
          parameters,
          execute: async (_id, args, signal) => {
            signal?.throwIfAborted();
            if (!Value.Check(parameters, args)) {
              throw new Error("Expected an optional focus string of at most 800 characters.");
            }
            return jsonResult({
              ...capability.request(args),
              note: "Requested, not completed. Continue normally; the host attempts it before the next model step once all tools settle, or after the reply if no safe boundary occurs.",
            });
          },
        };
      },
    }),
  ],
});
