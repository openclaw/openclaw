import type { EntityId, JsonValue, RelationshipEdge } from "../../../sre/contracts/entity.js";
export declare const RELATIONSHIP_INDEX_NODE_VERSION = "sre.relationship-index-node.v1";
export declare const RELATIONSHIP_INDEX_LATEST_VERSION = "sre.relationship-index-latest.v1";
export type RelationshipIndexNode = {
    version: typeof RELATIONSHIP_INDEX_NODE_VERSION;
    entityId: EntityId;
    entityType: string;
    observedAt: string;
    attributes?: {
        [key: string]: JsonValue;
    };
};
export type RelationshipIndexLatestSnapshot = {
    version: typeof RELATIONSHIP_INDEX_LATEST_VERSION;
    updatedAt: string;
    nodes: Record<string, RelationshipIndexNode>;
};
export type RelationshipIndexUpdate = {
    nodes: RelationshipIndexNode[];
    edges: RelationshipEdge[];
};
export type RelationshipIndexStorePaths = {
    rootDir: string;
    nodesPath: string;
    edgesPath: string;
    latestByEntityPath: string;
};
type RelationshipIndexStoreOptions = {
    env?: NodeJS.ProcessEnv;
    compactAfterBytes?: number;
};
export declare function resolveRelationshipIndexStorePaths(env?: NodeJS.ProcessEnv): RelationshipIndexStorePaths;
export declare function appendRelationshipIndexUpdate(update: RelationshipIndexUpdate, options?: RelationshipIndexStoreOptions): Promise<void>;
export declare function readRelationshipIndexLatestSnapshot(env?: NodeJS.ProcessEnv): Promise<RelationshipIndexLatestSnapshot | undefined>;
export {};
