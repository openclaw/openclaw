import type { TopologyEnvelope, TopologyRecord, TopologyReportName } from "./types.js";

function canonicalExportName(record: TopologyRecord): string {
  const finalColon = record.canonicalKey.lastIndexOf(":");
  return finalColon >= 0
    ? record.canonicalKey.slice(finalColon + 1)
    : (record.exportNames[0] ?? "<unknown>");
}

function primarySymbol(record: TopologyRecord): string {
  return `${record.publicSpecifiers[0] ?? "<unknown>"}:${canonicalExportName(record)}`;
}

function formatRecordLine(record: TopologyRecord): string {
  return (
    `- ${primarySymbol(record)} -> ${record.declarationPath}:${record.declarationLine} ` +
    `(prodRefs=${record.productionRefCount}, owners=${record.productionOwners.join(",") || "-"}, ` +
    `sharedness=${record.sharednessScore}, move=${record.moveBackToOwnerScore})`
  );
}

const recordReports: Record<
  Exclude<TopologyReportName, "public-surface-usage">,
  { summary: string; heading: string; format: (record: TopologyRecord) => string }
> = {
  "owner-map": {
    summary: "Production-owned records",
    heading: "owner-map records",
    format: (record) =>
      `- ${primarySymbol(record)} owners=${record.productionOwners.join(",")} ` +
      `extensions=${record.productionExtensions.join(",") || "-"} ` +
      `packages=${record.productionPackages.join(",") || "-"}`,
  },
  "single-owner-shared": {
    summary: "Single-owner shared exports",
    heading: "single-owner shared exports",
    format: formatRecordLine,
  },
  "unused-public-surface": {
    summary: "Unused public exports",
    heading: "unused exports",
    format: formatRecordLine,
  },
  "consumer-topology": {
    summary: "Records with consumers",
    heading: "consumer-topology records",
    format: (record) =>
      `- ${primarySymbol(record)} prod=${record.productionConsumers.length} ` +
      `test=${record.testConsumers.length} internal=${record.internalConsumers.length}`,
  },
};

export function renderTextReport(envelope: TopologyEnvelope, limit: number): string {
  if (envelope.report === "public-surface-usage") {
    const candidates = envelope.rankedCandidates?.candidateToMove ?? [];
    const duplicateExports = envelope.rankedCandidates?.duplicatedPublicExports ?? [];
    return [
      `Scope: ${envelope.scope.id}`,
      `Public exports analyzed: ${envelope.totals.exports}`,
      `Production-used exports: ${envelope.totals.usedByProduction}`,
      `Single-owner shared exports: ${envelope.totals.singleOwnerShared}`,
      `Unused public exports: ${envelope.totals.unused}`,
      "",
      `Top ${Math.min(limit, candidates.length)} candidate-to-move exports:`,
      ...candidates.slice(0, limit).map(formatRecordLine),
      "",
      `Top ${Math.min(limit, duplicateExports.length)} duplicated public exports:`,
      ...duplicateExports
        .slice(0, limit)
        .map(
          (record) =>
            `- ${primarySymbol(record)} via ${record.publicSpecifiers.join(", ")} ` +
            `(${record.declarationPath}:${record.declarationLine})`,
        ),
    ].join("\n");
  }
  const report = recordReports[envelope.report];
  if (!report) {
    throw new Error(`Unsupported topology report: ${envelope.report}`);
  }
  return [
    `Scope: ${envelope.scope.id}`,
    `${report.summary}: ${envelope.records.length}`,
    "",
    `Top ${Math.min(limit, envelope.records.length)} ${report.heading}:`,
    ...envelope.records.slice(0, limit).map(report.format),
  ].join("\n");
}
