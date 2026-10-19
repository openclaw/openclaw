import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import type { CodexPluginsManagementIO } from "./command-plugin-config.js";
import type {
  listCodexCliSessionsOnNode,
  resolveCodexCliSessionForBindingOnNode,
} from "./node-cli-sessions.js";

type ListCodexCliSessionsOnNodeFn = (
  params: Omit<Parameters<typeof listCodexCliSessionsOnNode>[0], "runtime">,
) => ReturnType<typeof listCodexCliSessionsOnNode>;

type ResolveCodexCliSessionForBindingOnNodeFn = (
  params: Omit<Parameters<typeof resolveCodexCliSessionForBindingOnNode>[0], "runtime">,
) => ReturnType<typeof resolveCodexCliSessionForBindingOnNode>;

export type CodexCommandDeps = {
  bindingStore: CodexAppServerBindingStore;
  listCodexCliSessionsOnNode: ListCodexCliSessionsOnNodeFn;
  resolveCodexCliSessionForBindingOnNode: ResolveCodexCliSessionForBindingOnNodeFn;
  codexPluginsManagementIo?: CodexPluginsManagementIO;
};
