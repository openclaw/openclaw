import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

// The plugin entry closes managers through this module, so Gateway shutdown never
// first-imports a chunk that an in-place update may already have replaced.
export const loadMemoryManagerRuntime = createLazyRuntimeModule(
  () => import("../../manager-runtime.js"),
);

export async function closeAllMemorySearchManagers(): Promise<void> {
  if (!loadMemoryManagerRuntime.peek()) {
    return;
  }
  const { closeAllMemoryIndexManagers } = await loadMemoryManagerRuntime();
  await closeAllMemoryIndexManagers();
}
