import { AsyncLocalStorage } from "node:async_hooks";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type MemoryBackgroundContext = ReturnType<typeof AsyncLocalStorage.snapshot>;

// Background resources must not retain the turn that opens a manager or
// publishes a transcript update, so they run in a context captured outside
// turns. Bundled modules survive an in-process Gateway restart: a context
// captured once at module load would pin the first plugin generation and
// resolve its retired providers. Each registration captures its own context in
// a per-instance slot; the module-load context only serves hosts that never
// registered this instance.
const moduleLoadContext = AsyncLocalStorage.snapshot();

const backgroundContextStore = createPluginRuntimeStore<MemoryBackgroundContext>({
  key: "memory-core:background-context",
  errorMessage: "Memory background context is not initialized",
});

export function captureMemoryBackgroundContext(): void {
  backgroundContextStore.setRuntime(AsyncLocalStorage.snapshot());
}

// Resolve from the owning instance's frame (manager setup, or before installing
// a callback), never from a foreign emitter's frame.
export function resolveMemoryBackgroundContext(): MemoryBackgroundContext {
  return backgroundContextStore.tryGetRuntime() ?? moduleLoadContext;
}
