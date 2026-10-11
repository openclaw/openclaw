import { AsyncLocalStorage } from "node:async_hooks";
import type { MemoryCoreRuntimeHost } from "./runtime-host.js";

// Direct manager fixtures own their background lifetime outside managed plugin loading.
export const runInMemoryTestBackgroundContext: NonNullable<
  MemoryCoreRuntimeHost["runInBackgroundContext"]
> = AsyncLocalStorage.snapshot();
