import type { Issue, LoadedRecord } from "./model.js";
import type { OntologySource, resolveOntology } from "./ontology.js";

/** One validated vault scan: records, resolved ontology, its sources and issues. */
export type ScanResult = {
  records: LoadedRecord[];
  ontology: ReturnType<typeof resolveOntology>;
  sources: OntologySource[];
  issues: Issue[];
  checkedAt: string;
};
