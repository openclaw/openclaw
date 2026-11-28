import type { AcquireConfiguredProviderLocalService } from "openclaw/plugin-sdk/embedding-providers";
import type { MemoryCoreOpenKeyedStore } from "../dreaming-state.js";

export type MemoryCoreRuntimeHost = {
  acquireLocalService?: AcquireConfiguredProviderLocalService;
  openKeyedStore?: MemoryCoreOpenKeyedStore;
  runInBackgroundContext?: <T>(run: () => T) => T;
};
