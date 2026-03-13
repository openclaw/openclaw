import type { EntityId, ProvenanceRef } from "./entity.js";
export type IncidentDossierTimelineEntry = {
    at: string;
    kind: "bundle" | "change" | "note" | "plan";
    refId: string;
    summary: string;
};
export type IncidentDossierIndex = {
    version: "sre.incident-dossier-index.v1";
    incidentId: string;
    title: string;
    status: "open" | "monitoring" | "resolved";
    updatedAt: string;
    entityIds: EntityId[];
    bundleIds: string[];
    planIds: string[];
    provenance: ProvenanceRef[];
    timeline: IncidentDossierTimelineEntry[];
};
export declare function createIncidentDossierId(params: Pick<IncidentDossierIndex, "incidentId" | "updatedAt">): string;
export declare function createIncidentDossierIndex(params: Omit<IncidentDossierIndex, "bundleIds" | "entityIds" | "planIds" | "timeline" | "version"> & {
    bundleIds?: string[];
    entityIds?: EntityId[];
    planIds?: string[];
    timeline?: IncidentDossierTimelineEntry[];
}): IncidentDossierIndex;
