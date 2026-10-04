import { sameSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import { withSessionTranscriptWriteAssertion } from "../../../config/sessions/transcript-write-context.js";
import { withSessionManagerWriteAssertion } from "../session-manager-write-admission.js";
import type { SessionManager } from "../session-manager.js";
import type { ExtensionActions, ExtensionActionsV2, ExtensionRuntime } from "./types.js";

function bindPersistenceScope(
  manager: Pick<SessionManager, "getSessionTarget">,
  runtime: ExtensionRuntime,
) {
  return <T>(action: () => Promise<T>): Promise<T> => {
    runtime.assertActive();
    const target = manager.getSessionTarget();
    const assertCurrent = () => {
      runtime.assertActive();
      const current = manager.getSessionTarget();
      if (!sameSessionTranscriptTargetBinding(target, current)) {
        throw new Error("Extension session manager changed before metadata persistence");
      }
    };
    return withSessionManagerWriteAssertion(manager, assertCurrent, () =>
      target ? withSessionTranscriptWriteAssertion(target, assertCurrent, action) : action(),
    );
  };
}

/** Retain the bound runtime and manager through queued metadata transaction/commit grants. */
export function bindExtensionMetadataActions(
  manager: Pick<SessionManager, "getSessionTarget">,
  runtime: ExtensionRuntime,
  actions: Pick<ExtensionActions, "setModel" | "setThinkingLevel">,
): void {
  const run = bindPersistenceScope(manager, runtime);
  runtime.setModel = (model) => run(() => actions.setModel(model));
  runtime.setThinkingLevel = (level) => run(() => actions.setThinkingLevel(level));
}

/** Bind awaited writes to the same runtime and transcript target through worker commit. */
export function bindExtensionPersistenceActions(
  manager: Pick<SessionManager, "getSessionTarget">,
  runtime: ExtensionRuntime,
  actions: ExtensionActionsV2,
): void {
  const run = bindPersistenceScope(manager, runtime);
  runtime.appendEntryAsync = (customType, data) =>
    run(() => actions.appendEntryAsync(customType, data));
  runtime.setSessionNameAsync = (name) => run(() => actions.setSessionNameAsync(name));
  runtime.setLabelAsync = (entryId, label) => run(() => actions.setLabelAsync(entryId, label));
}
