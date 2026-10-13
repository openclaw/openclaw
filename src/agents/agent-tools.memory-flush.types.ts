/** Provider-owned persistence surface for one tools-arm memory flush run. */
export type MemoryFlushToolRunContext = {
  flushId: string;
  ownerPluginId: string;
  persistenceToolNames: readonly string[];
  lookupToolNames?: readonly string[];
  recordPersistenceToolSuccess: () => void;
};
