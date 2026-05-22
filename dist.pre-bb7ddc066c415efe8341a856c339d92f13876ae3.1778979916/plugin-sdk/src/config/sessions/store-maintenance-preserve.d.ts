export type SessionMaintenancePreserveKeysProvider = () => Iterable<string> | undefined;
export declare function registerSessionMaintenancePreserveKeysProvider(provider: SessionMaintenancePreserveKeysProvider): () => void;
export declare function collectSessionMaintenancePreserveKeys(baseKeys?: Iterable<string | undefined>): Set<string> | undefined;
