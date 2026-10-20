import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";

export type SessionCompactionRequest = { focus?: string };

/** One request per run, shared across recovery attempts; tools never perform compaction. */
export function createSessionCompactionRequest() {
  let requested: SessionCompactionRequest | undefined;
  let consumed = false;
  return {
    get pending() {
      return consumed ? undefined : requested;
    },
    takePending() {
      const pending = consumed ? undefined : requested;
      consumed ||= pending !== undefined;
      return pending;
    },
    bind(assertCurrent: () => void): NonNullable<OpenClawPluginToolContext["sessionCompaction"]> {
      return {
        request: (request) => {
          assertCurrent();
          if (requested) {
            return { status: "already_requested" };
          }
          const focus = request.focus?.trim();
          requested = focus ? { focus: truncateCodePoints(focus, 800) } : {};
          return { status: "requested" };
        },
      };
    },
  };
}
