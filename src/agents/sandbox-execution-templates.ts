import fs from "node:fs";
import path from "node:path";

export type SandboxExecutionTemplateId = "python-research" | "node-research";

export type SandboxExecutionTarget = {
  kind: "python" | "node";
  templateId: SandboxExecutionTemplateId;
  relOrAbsPath: string;
};

type SandboxExecutionTemplate = {
  id: SandboxExecutionTemplateId;
  allowedImports: ReadonlySet<string>;
  deniedImports: ReadonlySet<string>;
  allowedImportsSummary: string;
};

const PYTHON_RESEARCH_ALLOWED_IMPORTS = [
  "argparse",
  "bisect",
  "collections",
  "csv",
  "dataclasses",
  "datetime",
  "decimal",
  "functools",
  "heapq",
  "itertools",
  "json",
  "math",
  "pathlib",
  "random",
  "re",
  "statistics",
  "string",
  "sys",
  "textwrap",
  "typing",
] as const;

const PYTHON_RESEARCH_DENIED_IMPORTS = [
  "asyncio",
  "ctypes",
  "ftplib",
  "http",
  "importlib",
  "marshal",
  "multiprocessing",
  "os",
  "pickle",
  "runpy",
  "site",
  "socket",
  "subprocess",
  "telnetlib",
  "urllib",
] as const;

const NODE_RESEARCH_ALLOWED_IMPORTS = [
  "node:assert",
  "node:assert/strict",
  "node:buffer",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:stream",
  "node:stream/promises",
  "node:string_decoder",
  "node:timers/promises",
  "node:url",
  "node:util",
] as const;

const NODE_RESEARCH_DENIED_IMPORTS = [
  "node:child_process",
  "node:cluster",
  "node:dgram",
  "node:dns",
  "node:dns/promises",
  "node:http",
  "node:https",
  "node:inspector",
  "node:module",
  "node:net",
  "node:tls",
  "node:vm",
  "node:worker_threads",
] as const;

const NODE_BUILTIN_ALIASES = new Map<string, string>([
  ...NODE_RESEARCH_ALLOWED_IMPORTS.map((name) => [name.slice("node:".length), name] as const),
  ...NODE_RESEARCH_DENIED_IMPORTS.map((name) => [name.slice("node:".length), name] as const),
]);

function createTemplate(
  id: SandboxExecutionTemplateId,
  allowedImports: readonly string[],
  deniedImports: readonly string[],
): SandboxExecutionTemplate {
  const allowed = new Set(allowedImports);
  return {
    id,
    allowedImports: allowed,
    deniedImports: new Set(deniedImports),
    allowedImportsSummary: Array.from(allowed).toSorted().join(", "),
  };
}

const PYTHON_RESEARCH_TEMPLATE = createTemplate(
  "python-research",
  PYTHON_RESEARCH_ALLOWED_IMPORTS,
  PYTHON_RESEARCH_DENIED_IMPORTS,
);

const NODE_RESEARCH_TEMPLATE = createTemplate(
  "node-research",
  NODE_RESEARCH_ALLOWED_IMPORTS,
  NODE_RESEARCH_DENIED_IMPORTS,
);

function resolveTemplate(kind: "python" | "node"): SandboxExecutionTemplate {
  return kind === "python" ? PYTHON_RESEARCH_TEMPLATE : NODE_RESEARCH_TEMPLATE;
}

function stripQuotedCommandPrefix(raw: string): string {
  return raw.trim();
}

export function extractSandboxExecutionTargetFromCommand(
  command: string,
): SandboxExecutionTarget | null {
  const raw = stripQuotedCommandPrefix(command);
  if (!raw) {
    return null;
  }

  const pythonMatch = raw.match(
    /^\s*(python(?:\d+(?:\.\d+)?)?)\s+(?:-[^\s]+\s+)*([^\s"'`][^\s]*\.py)\b/i,
  );
  if (pythonMatch?.[2]) {
    return {
      kind: "python",
      templateId: "python-research",
      relOrAbsPath: pythonMatch[2],
    };
  }

  const nodeMatch = raw.match(
    /^\s*node\s+(?:--[^\s]+(?:=\S+)?\s+|-[^\s]+\s+)*([^\s"'`][^\s]*\.(?:[cm]?js))\b/i,
  );
  if (nodeMatch?.[1]) {
    return {
      kind: "node",
      templateId: "node-research",
      relOrAbsPath: nodeMatch[1],
    };
  }

  return null;
}

function isWithinDir(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileExists(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function resolvePythonLocalImport(params: {
  specifier: string;
  filePath: string;
  workdir: string;
}): boolean {
  const trimmed = params.specifier.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith(".")) {
    return true;
  }

  const rootName = trimmed.split(".")[0]?.trim();
  if (!rootName) {
    return false;
  }

  const candidateRoots = [path.dirname(params.filePath), params.workdir];
  for (const candidateRoot of candidateRoots) {
    const fileCandidate = path.resolve(candidateRoot, `${rootName}.py`);
    if (isWithinDir(fileCandidate, params.workdir) && fileExists(fileCandidate)) {
      return true;
    }
    const packageDir = path.resolve(candidateRoot, rootName);
    const initCandidate = path.join(packageDir, "__init__.py");
    if (
      isWithinDir(packageDir, params.workdir) &&
      directoryExists(packageDir) &&
      fileExists(initCandidate)
    ) {
      return true;
    }
  }

  return false;
}

function canonicalizeNodeSpecifier(specifier: string): string {
  const trimmed = specifier.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("node:")) {
    return trimmed;
  }
  return NODE_BUILTIN_ALIASES.get(trimmed) ?? trimmed;
}

function resolveNodeLocalImport(params: {
  specifier: string;
  filePath: string;
  workdir: string;
}): boolean {
  const trimmed = params.specifier.trim();
  if (!(trimmed.startsWith("./") || trimmed.startsWith("../"))) {
    return false;
  }

  const base = path.resolve(path.dirname(params.filePath), trimmed);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
    path.join(base, "index.cjs"),
  ];

  return candidates.some(
    (candidate) => isWithinDir(candidate, params.workdir) && fileExists(candidate),
  );
}

function buildImportError(params: {
  template: SandboxExecutionTemplate;
  filePath: string;
  line: number;
  specifier: string;
  detail: string;
  localHelp: string;
}): Error {
  return new Error(
    [
      `exec preflight: sandbox template "${params.template.id}" blocks import "${params.specifier}" in ${path.basename(
        params.filePath,
      )}:${params.line}.`,
      params.detail,
      `Allowed imports: ${params.template.allowedImportsSummary}.`,
      params.localHelp,
    ].join("\n"),
  );
}

function assertPythonImportAllowed(params: {
  template: SandboxExecutionTemplate;
  specifier: string;
  filePath: string;
  workdir: string;
  line: number;
}): void {
  const rootSpecifier = params.specifier.trim().replace(/^\.+/, "").split(".")[0]?.trim();
  if (!rootSpecifier) {
    return;
  }
  if (params.template.deniedImports.has(rootSpecifier)) {
    throw buildImportError({
      template: params.template,
      filePath: params.filePath,
      line: params.line,
      specifier: rootSpecifier,
      detail:
        "Unsafe stdlib/process/network imports are not allowed inside the sandbox research template.",
      localHelp:
        "Allowed local imports: relative imports or workspace-local modules/packages that resolve inside the sandbox workdir.",
    });
  }
  if (params.template.allowedImports.has(rootSpecifier)) {
    return;
  }
  if (
    resolvePythonLocalImport({
      specifier: params.specifier,
      filePath: params.filePath,
      workdir: params.workdir,
    })
  ) {
    return;
  }
  throw buildImportError({
    template: params.template,
    filePath: params.filePath,
    line: params.line,
    specifier: rootSpecifier,
    detail:
      "Only deterministic stdlib imports and workspace-local modules are allowed for sandboxed Python research scripts.",
    localHelp:
      "Third-party packages and non-local bare imports are denied unless the template allowlist is expanded in code.",
  });
}

function validatePythonImports(params: {
  template: SandboxExecutionTemplate;
  filePath: string;
  workdir: string;
  content: string;
}): void {
  const lines = params.content.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/#.*$/, "");
    if (!line.trim()) {
      continue;
    }
    if (/\b__import__\s*\(/.test(line)) {
      throw buildImportError({
        template: params.template,
        filePath: params.filePath,
        line: index + 1,
        specifier: "__import__",
        detail: "Dynamic Python imports are not allowed inside sandbox research templates.",
        localHelp:
          "Use explicit import statements so the sandbox validator can prove which modules are used.",
      });
    }

    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch?.[1]) {
      const specifiers = importMatch[1]
        .split(",")
        .map((part) =>
          part
            .trim()
            .split(/\s+as\s+/i)[0]
            ?.trim(),
        )
        .filter((part): part is string => Boolean(part));
      for (const specifier of specifiers) {
        assertPythonImportAllowed({
          template: params.template,
          specifier,
          filePath: params.filePath,
          workdir: params.workdir,
          line: index + 1,
        });
      }
      continue;
    }

    const fromMatch = line.match(/^\s*from\s+([.\w]+)\s+import\s+/);
    if (fromMatch?.[1]) {
      assertPythonImportAllowed({
        template: params.template,
        specifier: fromMatch[1],
        filePath: params.filePath,
        workdir: params.workdir,
        line: index + 1,
      });
    }
  }
}

function assertNodeImportAllowed(params: {
  template: SandboxExecutionTemplate;
  specifier: string;
  filePath: string;
  workdir: string;
  line: number;
}): void {
  const canonical = canonicalizeNodeSpecifier(params.specifier);
  if (params.template.deniedImports.has(canonical)) {
    throw buildImportError({
      template: params.template,
      filePath: params.filePath,
      line: params.line,
      specifier: canonical,
      detail:
        "Process, network, VM, and dynamic module-control imports are blocked in the sandbox Node research template.",
      localHelp: "Allowed local imports: relative files that resolve inside the sandbox workdir.",
    });
  }
  if (params.template.allowedImports.has(canonical)) {
    return;
  }
  if (
    resolveNodeLocalImport({
      specifier: params.specifier,
      filePath: params.filePath,
      workdir: params.workdir,
    })
  ) {
    return;
  }
  throw buildImportError({
    template: params.template,
    filePath: params.filePath,
    line: params.line,
    specifier: params.specifier,
    detail:
      "Only allowed `node:` builtins and relative workspace-local files are permitted for sandboxed Node research scripts.",
    localHelp:
      "Bare external packages are denied unless the template allowlist is expanded in code.",
  });
}

function validateNodeImports(params: {
  template: SandboxExecutionTemplate;
  filePath: string;
  workdir: string;
  content: string;
}): void {
  const literalPatterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"'`]+\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const lines = params.content.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }

    let foundLiteralImport = false;
    for (const pattern of literalPatterns) {
      pattern.lastIndex = 0;
      for (const match of trimmed.matchAll(pattern)) {
        const specifier = match[1]?.trim();
        if (!specifier) {
          continue;
        }
        foundLiteralImport = true;
        assertNodeImportAllowed({
          template: params.template,
          specifier,
          filePath: params.filePath,
          workdir: params.workdir,
          line: index + 1,
        });
      }
    }

    if (/\brequire\(/.test(trimmed) && !/\brequire\(\s*["'][^"']+["']\s*\)/.test(trimmed)) {
      throw buildImportError({
        template: params.template,
        filePath: params.filePath,
        line: index + 1,
        specifier: "require(...)",
        detail: "Dynamic require() calls are not allowed inside sandbox Node research templates.",
        localHelp:
          "Use explicit string-literal imports so the validator can prove which dependencies are used.",
      });
    }
    if (/\bimport\(/.test(trimmed) && !/\bimport\(\s*["'][^"']+["']\s*\)/.test(trimmed)) {
      throw buildImportError({
        template: params.template,
        filePath: params.filePath,
        line: index + 1,
        specifier: "import(...)",
        detail: "Dynamic import() calls are not allowed inside sandbox Node research templates.",
        localHelp:
          "Use explicit static imports or literal dynamic imports that stay inside the allowlist.",
      });
    }

    if (!foundLiteralImport && /\bexport\s+[^"'`]+\s+from\s+/.test(trimmed)) {
      throw buildImportError({
        template: params.template,
        filePath: params.filePath,
        line: index + 1,
        specifier: "export ... from",
        detail: "Re-export specifiers must use explicit string literals.",
        localHelp:
          "Use a normal string-literal module specifier so the sandbox validator can evaluate it.",
      });
    }
  }
}

export function validateSandboxExecutionTemplateImports(params: {
  kind: "python" | "node";
  filePath: string;
  workdir: string;
  content: string;
}): void {
  const template = resolveTemplate(params.kind);
  if (params.kind === "python") {
    validatePythonImports({
      template,
      filePath: params.filePath,
      workdir: params.workdir,
      content: params.content,
    });
    return;
  }
  validateNodeImports({
    template,
    filePath: params.filePath,
    workdir: params.workdir,
    content: params.content,
  });
}
