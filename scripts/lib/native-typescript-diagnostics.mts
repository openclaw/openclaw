import { DiagnosticCategory, type Diagnostic, type Project } from "typescript/unstable/sync";

/** Preserve compiler diagnostics across the native program's separate query surfaces. */
export function collectNativeTypeScriptDiagnostics(
  project: Project,
  options: { includeSemantic?: boolean; includeDeclaration?: boolean } = {},
): Diagnostic[] {
  const program = project.program;
  const diagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getBindDiagnostics(),
    ...(options.includeSemantic === false ? [] : program.getSemanticDiagnostics()),
    ...(options.includeDeclaration ? program.getDeclarationDiagnostics() : []),
  ];
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

export function formatNativeTypeScriptDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const format = (diagnostic: Diagnostic, indent = ""): string => {
    const location = diagnostic.fileName
      ? `${diagnostic.fileName}${diagnostic.pos >= 0 ? `@${diagnostic.pos}` : ""}: `
      : "";
    const category = DiagnosticCategory[diagnostic.category].toLowerCase();
    return [
      `${indent}${location}${category} TS${diagnostic.code}: ${diagnostic.text}`,
      ...(diagnostic.messageChain ?? []).map((message) => format(message, `${indent}  `)),
      ...(diagnostic.relatedInformation ?? []).map((message) => format(message, `${indent}  `)),
    ].join("\n");
  };
  return diagnostics.map((diagnostic) => format(diagnostic)).join("\n");
}
