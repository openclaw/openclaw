import crypto from "node:crypto";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import * as ts from "typescript";
import type { SandboxDockerSettings } from "../../config/types.sandbox.js";
import { stableStringify } from "../stable-stringify.js";
import type { SandboxToolPolicy, SandboxWorkspaceAccess } from "./types.js";

const POSIX = path.posix;
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const SOURCE_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const BUILTIN_MODULE_NAMES = new Set(
  builtinModules.flatMap((entry) =>
    entry.startsWith("node:") ? [entry, entry.slice(5)] : [entry, `node:${entry}`],
  ),
);

export const EXECUTION_SANDBOX_TEMPLATE_IDS = ["ts-research-v1"] as const;
export type ExecutionSandboxTemplateId = (typeof EXECUTION_SANDBOX_TEMPLATE_IDS)[number];

export type ExecutionSandboxRuntimeEnvelope = {
  workspaceAccess: SandboxWorkspaceAccess;
  toolPolicy: SandboxToolPolicy;
  docker: Pick<SandboxDockerSettings, "network" | "readOnlyRoot" | "tmpfs">;
};

export type ExecutionSandboxTemplateManifest = {
  id: ExecutionSandboxTemplateId;
  title: string;
  description: string;
  language: "typescript";
  entrypoint: string;
  allowedBareSpecifiers: string[];
  allowedBarePrefixes: string[];
  blockedBareSpecifiers: string[];
  blockedBarePrefixes: string[];
  runtime: ExecutionSandboxRuntimeEnvelope;
};

export type ExecutionSandboxTemplate = {
  manifest: ExecutionSandboxTemplateManifest;
  files: Record<string, string>;
  fingerprint: string;
};

export type ExecutionSandboxMaterializeResult = {
  fingerprint: string;
  writtenFiles: string[];
};

export type ExecutionSandboxImportKind =
  | "import"
  | "export"
  | "require"
  | "dynamic-import"
  | "import-type";

export type ExecutionSandboxValidationCode =
  | "absolute-import"
  | "blocked-bare-import"
  | "missing-relative-import"
  | "non-literal-import"
  | "relative-import-escape"
  | "unallowlisted-bare-import";

export type ExecutionSandboxValidationDiagnostic = {
  code: ExecutionSandboxValidationCode;
  filePath: string;
  importKind: ExecutionSandboxImportKind;
  message: string;
  line: number;
  column: number;
  specifier?: string;
};

export type ExecutionSandboxValidationResult = {
  ok: boolean;
  diagnostics: ExecutionSandboxValidationDiagnostic[];
};

type ExecutionSandboxTemplateSeed = {
  manifest: ExecutionSandboxTemplateManifest;
  files: Record<string, string>;
};

type ImportRecord = {
  kind: ExecutionSandboxImportKind;
  specifier?: string;
  literal: boolean;
  line: number;
  column: number;
};

const TS_RESEARCH_TEMPLATE: ExecutionSandboxTemplateSeed = {
  manifest: {
    id: "ts-research-v1",
    title: "TypeScript Research Sandbox v1",
    description:
      "Fail-closed TypeScript execution template for generated research code with no third-party dependencies.",
    language: "typescript",
    entrypoint: "src/main.ts",
    allowedBareSpecifiers: ["node:assert/strict"],
    allowedBarePrefixes: [],
    blockedBareSpecifiers: [
      "child_process",
      "fs",
      "http",
      "https",
      "net",
      "os",
      "process",
      "tls",
      "vm",
      "worker_threads",
      "node:child_process",
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:os",
      "node:process",
      "node:tls",
      "node:vm",
      "node:worker_threads",
    ],
    blockedBarePrefixes: [
      "@aws-sdk/",
      "@google-cloud/",
      "@openai/",
      "playwright",
      "playwright-core",
      "undici",
    ],
    runtime: {
      workspaceAccess: "rw",
      toolPolicy: {
        allow: ["exec", "process", "read", "write", "edit", "apply_patch"],
        deny: [
          "browser",
          "canvas",
          "cron",
          "gateway",
          "nodes",
          "session_status",
          "sessions_history",
          "sessions_list",
          "sessions_send",
          "sessions_spawn",
          "subagents",
        ],
      },
      docker: {
        network: "none",
        readOnlyRoot: true,
        tmpfs: ["/tmp", "/var/tmp", "/run"],
      },
    },
  },
  files: {
    "README.md": `# TypeScript Research Sandbox v1

This template is intentionally small and deterministic.

- No third-party dependencies
- Network disabled by runtime policy
- Imports fail closed unless they are relative or explicitly allowlisted
- The default entrypoint is \`src/main.ts\`
`,
    "package.json": `{
  "name": "openclaw-execution-sandbox-ts-research-v1",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "scripts": {
    "check": "tsc --noEmit"
  }
}
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
`,
    "src/lib/decision-log.ts": `export type StrategyDecision = {
  symbol: string;
  action: "buy" | "sell" | "hold";
  confidence: number;
};

export function summarizeDecision(decision: StrategyDecision): string {
  return [
    decision.symbol,
    decision.action,
    decision.confidence.toFixed(3),
  ].join(":");
}
`,
    "src/main.ts": `import assert from "node:assert/strict";
import { summarizeDecision, type StrategyDecision } from "./lib/decision-log.js";

export function run(decision: StrategyDecision): string {
  assert.ok(decision.confidence >= 0 && decision.confidence <= 1, "confidence must be between 0 and 1");
  return summarizeDecision(decision);
}
`,
  },
};

const EXECUTION_SANDBOX_TEMPLATES: Record<
  ExecutionSandboxTemplateId,
  ExecutionSandboxTemplateSeed
> = {
  "ts-research-v1": TS_RESEARCH_TEMPLATE,
};

export function isExecutionSandboxTemplateId(value: string): value is ExecutionSandboxTemplateId {
  return EXECUTION_SANDBOX_TEMPLATE_IDS.includes(value as ExecutionSandboxTemplateId);
}

export function listExecutionSandboxTemplates(): ExecutionSandboxTemplate[] {
  return EXECUTION_SANDBOX_TEMPLATE_IDS.map((id) => getExecutionSandboxTemplate(id));
}

export function getExecutionSandboxTemplate(
  id: ExecutionSandboxTemplateId,
): ExecutionSandboxTemplate {
  const seed = EXECUTION_SANDBOX_TEMPLATES[id];
  const manifest = cloneManifest(seed.manifest);
  const files = cloneFiles(seed.files);
  return {
    manifest,
    files,
    fingerprint: fingerprintTemplate({ manifest, files }),
  };
}

export async function materializeExecutionSandboxTemplate(params: {
  destinationDir: string;
  id: ExecutionSandboxTemplateId;
  overwrite?: boolean;
}): Promise<ExecutionSandboxMaterializeResult> {
  const template = getExecutionSandboxTemplate(params.id);
  const writtenFiles: string[] = [];

  for (const [relativePath, content] of sortedEntries(template.files)) {
    const destinationPath = path.join(params.destinationDir, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, content, {
      encoding: "utf8",
      flag: params.overwrite ? "w" : "wx",
    });
    writtenFiles.push(destinationPath);
  }

  return {
    fingerprint: template.fingerprint,
    writtenFiles,
  };
}

export function validateExecutionSandboxSources(params: {
  template: ExecutionSandboxTemplate;
  files: Record<string, string>;
}): ExecutionSandboxValidationResult {
  const files = normalizeFileMap(params.files);
  const fileSet = new Set(Object.keys(files));
  const diagnostics: ExecutionSandboxValidationDiagnostic[] = [];

  for (const [filePath, content] of sortedEntries(files)) {
    if (!isSourceFile(filePath)) {
      continue;
    }
    const imports = collectImportRecords(filePath, content);
    for (const record of imports) {
      inspectImportRecord({
        template: params.template,
        filePath,
        record,
        fileSet,
        diagnostics,
      });
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

function inspectImportRecord(params: {
  template: ExecutionSandboxTemplate;
  filePath: string;
  record: ImportRecord;
  fileSet: Set<string>;
  diagnostics: ExecutionSandboxValidationDiagnostic[];
}) {
  const { record } = params;
  if (!record.literal || !record.specifier) {
    params.diagnostics.push(
      createDiagnostic({
        filePath: params.filePath,
        record,
        code: "non-literal-import",
        message:
          "Imports must use string literals so the sandbox validator can evaluate them deterministically.",
      }),
    );
    return;
  }

  const specifier = record.specifier.trim();
  if (!specifier) {
    params.diagnostics.push(
      createDiagnostic({
        filePath: params.filePath,
        record,
        code: "non-literal-import",
        message: "Import specifier must not be blank.",
      }),
    );
    return;
  }

  if (isRelativeSpecifier(specifier)) {
    const resolved = resolveRelativeImport(params.filePath, specifier, params.fileSet);
    if (resolved.status === "escape") {
      params.diagnostics.push(
        createDiagnostic({
          filePath: params.filePath,
          record,
          code: "relative-import-escape",
          message: `Relative import escapes the sandbox root: ${specifier}`,
          specifier,
        }),
      );
      return;
    }
    if (resolved.status === "missing") {
      params.diagnostics.push(
        createDiagnostic({
          filePath: params.filePath,
          record,
          code: "missing-relative-import",
          message: `Relative import does not resolve inside the sandbox template: ${specifier}`,
          specifier,
        }),
      );
    }
    return;
  }

  if (isAbsoluteLikeSpecifier(specifier)) {
    params.diagnostics.push(
      createDiagnostic({
        filePath: params.filePath,
        record,
        code: "absolute-import",
        message: `Absolute and URL-based imports are blocked inside execution sandboxes: ${specifier}`,
        specifier,
      }),
    );
    return;
  }

  if (
    matchesImportRule(
      specifier,
      params.template.manifest.blockedBareSpecifiers,
      params.template.manifest.blockedBarePrefixes,
    )
  ) {
    params.diagnostics.push(
      createDiagnostic({
        filePath: params.filePath,
        record,
        code: "blocked-bare-import",
        message: `Import is explicitly blocked by the execution sandbox policy: ${specifier}`,
        specifier,
      }),
    );
    return;
  }

  if (
    matchesImportRule(
      specifier,
      params.template.manifest.allowedBareSpecifiers,
      params.template.manifest.allowedBarePrefixes,
    )
  ) {
    return;
  }

  const builtInHint = isBuiltinBareSpecifier(specifier)
    ? " Node builtins must be explicitly allowlisted."
    : "";
  params.diagnostics.push(
    createDiagnostic({
      filePath: params.filePath,
      record,
      code: "unallowlisted-bare-import",
      message: `Import is not allowlisted for ${params.template.manifest.id}: ${specifier}.${builtInHint}`,
      specifier,
    }),
  );
}

function collectImportRecords(filePath: string, content: string): ImportRecord[] {
  const scriptKind = scriptKindFromFilePath(filePath);
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const records: ImportRecord[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      records.push(importRecordFromNode(sourceFile, node.moduleSpecifier, "import"));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      records.push(importRecordFromNode(sourceFile, node.moduleSpecifier, "export"));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      records.push(importRecordFromNode(sourceFile, node.moduleReference.expression, "require"));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      records.push(importRecordFromNode(sourceFile, arg, "dynamic-import"));
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const arg = node.arguments[0];
      records.push(importRecordFromNode(sourceFile, arg, "require"));
    } else if (ts.isImportTypeNode(node)) {
      records.push(importRecordFromNode(sourceFile, node.argument, "import-type"));
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return records;
}

function importRecordFromNode(
  sourceFile: ts.SourceFile,
  node: ts.Node | undefined,
  kind: ExecutionSandboxImportKind,
): ImportRecord {
  const position = node?.getStart(sourceFile) ?? 0;
  const lineAndColumn = ts.getLineAndCharacterOfPosition(sourceFile, position);
  const literal = extractLiteralSpecifier(node);
  return {
    kind,
    specifier: literal ?? undefined,
    literal: literal !== null,
    line: lineAndColumn.line + 1,
    column: lineAndColumn.character + 1,
  };
}

function extractLiteralSpecifier(node: ts.Node | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) {
    return node.literal.text;
  }
  return null;
}

function resolveRelativeImport(
  fromFilePath: string,
  specifier: string,
  fileSet: Set<string>,
): { status: "ok" | "missing" | "escape" } {
  const fromDir = POSIX.dirname(fromFilePath);
  const normalized = POSIX.normalize(POSIX.join(fromDir, specifier));
  if (normalized === ".." || normalized.startsWith("../")) {
    return { status: "escape" };
  }

  for (const candidate of candidateRelativeResolutions(normalized)) {
    if (fileSet.has(candidate)) {
      return { status: "ok" };
    }
  }
  return { status: "missing" };
}

function candidateRelativeResolutions(normalizedPath: string): string[] {
  const results = new Set<string>([normalizedPath]);
  const extension = POSIX.extname(normalizedPath);
  const basePath = extension ? normalizedPath.slice(0, -extension.length) : normalizedPath;

  if (extension && [".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    results.add(`${basePath}.ts`);
    results.add(`${basePath}.tsx`);
    results.add(`${basePath}.mts`);
    results.add(`${basePath}.cts`);
  }

  if (!extension) {
    for (const candidateExtension of SOURCE_RESOLUTION_EXTENSIONS) {
      results.add(`${normalizedPath}${candidateExtension}`);
      results.add(POSIX.join(normalizedPath, `index${candidateExtension}`));
    }
  }

  return [...results];
}

function isBuiltinBareSpecifier(specifier: string): boolean {
  const root = bareImportRoot(specifier);
  return BUILTIN_MODULE_NAMES.has(root) || BUILTIN_MODULE_NAMES.has(`node:${root}`);
}

function matchesImportRule(specifier: string, exact: string[], prefixes: string[]): boolean {
  if (exact.includes(specifier)) {
    return true;
  }
  return prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

function bareImportRoot(specifier: string): string {
  const withoutNodePrefix = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (withoutNodePrefix.startsWith("@")) {
    const [scope = withoutNodePrefix, name = ""] = withoutNodePrefix.split("/", 3);
    return name ? `${scope}/${name}` : scope;
  }
  const [root = withoutNodePrefix] = withoutNodePrefix.split("/", 2);
  return root;
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_FILE_EXTENSIONS.has(POSIX.extname(filePath));
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isAbsoluteLikeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    /^[a-zA-Z]:[\\/]/.test(specifier) ||
    (/^[a-zA-Z][a-zA-Z+.-]*:/.test(specifier) && !specifier.startsWith("node:"))
  );
}

function scriptKindFromFilePath(filePath: string): ts.ScriptKind {
  const extension = POSIX.extname(filePath);
  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
      return ts.ScriptKind.JS;
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function fingerprintTemplate(template: {
  manifest: ExecutionSandboxTemplateManifest;
  files: Record<string, string>;
}): string {
  return crypto.createHash("sha256").update(stableStringify(template)).digest("hex");
}

function normalizeFileMap(files: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(files)) {
    const posixPath = normalizeTemplateFilePath(filePath);
    normalized[posixPath] = content;
  }
  return normalized;
}

function normalizeTemplateFilePath(filePath: string): string {
  const normalized = POSIX.normalize(filePath.replaceAll("\\", "/")).replace(/^\.\/+/, "");
  return normalized.replace(/^\/+/, "");
}

function createDiagnostic(params: {
  filePath: string;
  record: ImportRecord;
  code: ExecutionSandboxValidationCode;
  message: string;
  specifier?: string;
}): ExecutionSandboxValidationDiagnostic {
  return {
    code: params.code,
    filePath: params.filePath,
    importKind: params.record.kind,
    message: params.message,
    line: params.record.line,
    column: params.record.column,
    specifier: params.specifier,
  };
}

function cloneManifest(
  manifest: ExecutionSandboxTemplateManifest,
): ExecutionSandboxTemplateManifest {
  return {
    ...manifest,
    allowedBareSpecifiers: [...manifest.allowedBareSpecifiers],
    allowedBarePrefixes: [...manifest.allowedBarePrefixes],
    blockedBareSpecifiers: [...manifest.blockedBareSpecifiers],
    blockedBarePrefixes: [...manifest.blockedBarePrefixes],
    runtime: {
      workspaceAccess: manifest.runtime.workspaceAccess,
      toolPolicy: {
        allow: manifest.runtime.toolPolicy.allow
          ? [...manifest.runtime.toolPolicy.allow]
          : undefined,
        deny: manifest.runtime.toolPolicy.deny ? [...manifest.runtime.toolPolicy.deny] : undefined,
      },
      docker: {
        network: manifest.runtime.docker.network,
        readOnlyRoot: manifest.runtime.docker.readOnlyRoot,
        tmpfs: manifest.runtime.docker.tmpfs ? [...manifest.runtime.docker.tmpfs] : undefined,
      },
    },
  };
}

function cloneFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(sortedEntries(files));
}

function sortedEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).toSorted(([left], [right]) => left.localeCompare(right));
}
