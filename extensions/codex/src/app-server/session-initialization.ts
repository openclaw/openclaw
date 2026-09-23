import { createNativeSessionInitializationOwner } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import {
  validateBindingForWrite,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

const codexInitializations = createNativeSessionInitializationOwner<
  CodexAppServerBindingStore,
  CodexAppServerBindingIdentity,
  CodexAppServerThreadBinding
>({
  validateBinding: validateBindingForWrite,
  writeBinding: (store, identity, binding, assertCurrent) =>
    store.mutate(identity, { kind: "set", if: { kind: "absent" }, binding }, assertCurrent),
  errors: {
    linkChanged: "Codex initialization link changed before cleanup",
    bindingChanged: "Codex session binding changed during initialization",
    linkWriteFailed: "Codex initialization link could not be persisted",
    ownerChanged: "Codex initialization binding owner changed before rollback",
  },
});

export const prepareCodexSessionInitialization = codexInitializations.prepare;

export const getCodexSessionInitializationRollback = codexInitializations.getRollback;
