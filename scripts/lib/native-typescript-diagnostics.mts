import type { Project as AsyncProject } from "typescript/unstable/async";
import { DiagnosticCategory, type Diagnostic, type Project } from "typescript/unstable/sync";

type DiagnosticOptions = { includeSemantic?: boolean };

function diagnosticQueries(options: DiagnosticOptions) {
  return [
    "getConfigFileParsingDiagnostics",
    "getProgramDiagnostics",
    "getGlobalDiagnostics",
    "getSyntacticDiagnostics",
    "getBindDiagnostics",
    ...(options.includeSemantic === false ? [] : ["getSemanticDiagnostics" as const]),
  ] as const;
}

function uniqueDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const identity = JSON.stringify(diagnostic);
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
}

/** Preserve compiler diagnostics across the native program's separate query surfaces. */
export function collectNativeTypeScriptDiagnostics(
  project: Project,
  options: DiagnosticOptions = {},
): Diagnostic[] {
  return uniqueDiagnostics(diagnosticQueries(options).flatMap((query) => project.program[query]()));
}

export async function collectNativeTypeScriptDiagnosticsAsync(
  project: AsyncProject,
  options: DiagnosticOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const query of diagnosticQueries(options)) {
    diagnostics.push(...(await project.program[query]()));
  }
  return uniqueDiagnostics(diagnostics);
}

export function formatNativeTypeScriptDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const format = (diagnostic: Diagnostic, indent = ""): string => {
    const location = diagnostic.fileName
      ? `${diagnostic.fileName}${diagnostic.pos >= 0 ? `@${diagnostic.pos}` : ""}: `
      : "";
    const category = (DiagnosticCategory[diagnostic.category] ?? "Error").toLowerCase();
    return [
      `${indent}${location}${category} TS${diagnostic.code}: ${diagnostic.text}`,
      ...(diagnostic.messageChain ?? []).map((message) => format(message, `${indent}  `)),
      ...(diagnostic.relatedInformation ?? []).map((message) => format(message, `${indent}  `)),
    ].join("\n");
  };
  return diagnostics.map((diagnostic) => format(diagnostic)).join("\n");
}
