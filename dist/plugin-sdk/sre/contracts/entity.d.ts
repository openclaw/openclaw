export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type EntityId = string;
export declare const RELATIONSHIP_EDGE_TYPE_VALUES: readonly ["alerts_on", "belongs_to", "calls", "defined_in", "deploys", "depends_on", "emits", "impacts", "owned_by", "references"];
export type RelationshipEdgeType = (typeof RELATIONSHIP_EDGE_TYPE_VALUES)[number];
export declare const PROVENANCE_ARTIFACT_TYPE_VALUES: readonly ["alert", "config", "grafana_panel", "log_line", "metric", "pr", "repo_file", "runbook", "shell_command", "timeline_event", "trace"];
export type ProvenanceArtifactType = (typeof PROVENANCE_ARTIFACT_TYPE_VALUES)[number];
export type ProvenanceRef = {
    version: "sre.provenance-ref.v1";
    artifactType: ProvenanceArtifactType;
    source: string;
    locator: string;
    capturedAt: string;
    title?: string;
    fingerprint?: string;
    attributes?: {
        [key: string]: JsonValue;
    };
};
export type RelationshipEdge = {
    version: "sre.relationship-edge.v1";
    edgeId: string;
    from: EntityId;
    to: EntityId;
    edgeType: RelationshipEdgeType;
    discoveredAt: string;
    provenance: ProvenanceRef[];
    attributes?: {
        [key: string]: JsonValue;
    };
};
export declare function createEntityId(kind: string, ...parts: readonly string[]): EntityId;
export declare function createProvenanceFingerprint(ref: Omit<ProvenanceRef, "version">): string;
export declare function createRelationshipEdgeId(params: Pick<RelationshipEdge, "from" | "to" | "edgeType">): string;
export declare function createProvenanceRef(ref: Omit<ProvenanceRef, "fingerprint" | "version"> & {
    fingerprint?: string;
}): ProvenanceRef;
