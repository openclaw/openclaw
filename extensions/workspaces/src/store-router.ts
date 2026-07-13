import { WorkspaceStore } from "./store.js";

/** Keeps one shared writer per isolation domain while preserving the legacy default store. */
export class WorkspaceStoreRouter {
  readonly legacy: WorkspaceStore;
  private readonly stores = new Map<string, WorkspaceStore>();

  constructor(legacy = new WorkspaceStore()) {
    this.legacy = legacy;
    this.stores.set(legacy.isolationDomainId, legacy);
  }

  forDomain = (isolationDomainId: string): WorkspaceStore => {
    const existing = this.stores.get(isolationDomainId);
    if (existing) {
      return existing;
    }
    const store = new WorkspaceStore({
      stateDir: this.legacy.stateDir,
      isolationDomainId,
    });
    this.stores.set(isolationDomainId, store);
    return store;
  };

  close(): void {
    for (const store of this.stores.values()) {
      store.close();
    }
    this.stores.clear();
  }
}
