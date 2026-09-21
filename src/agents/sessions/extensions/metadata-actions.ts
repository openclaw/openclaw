import { withSessionTranscriptWriteAssertion } from "../../../config/sessions/transcript-write-context.js";
import type { SessionManager } from "../session-manager.js";
import type { ExtensionActions, ExtensionRuntime } from "./types.js";

/** Retain the bound runtime and manager through queued metadata transaction/commit grants. */
export function bindExtensionMetadataActions(
  manager: Pick<SessionManager, "getSessionTarget">,
  runtime: ExtensionRuntime,
  actions: Pick<ExtensionActions, "setModel" | "setThinkingLevel">,
): void {
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    runtime.assertActive();
    const target = manager.getSessionTarget();
    const assertCurrent = () => {
      runtime.assertActive();
      const current = manager.getSessionTarget();
      if (
        target
          ? !current ||
            (["agentId", "sessionId", "sessionKey", "storePath"] as const).some(
              (key) => target[key] !== current[key],
            )
          : current !== undefined
      ) {
        throw new Error("Extension session manager changed before metadata persistence");
      }
    };
    return target ? withSessionTranscriptWriteAssertion(target, assertCurrent, action) : action();
  };
  runtime.setModel = (model) => run(() => actions.setModel(model));
  runtime.setThinkingLevel = (level) => run(() => actions.setThinkingLevel(level));
}
