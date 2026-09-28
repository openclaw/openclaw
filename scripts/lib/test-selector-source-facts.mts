// Pre-install selectors use only built-ins and the shared Node executable resolver.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNodeRuntimeExecutable } from "../../src/infra/node-runtime-executable.ts";
import { createSourceTermMatcher } from "./test-source-term-matcher.mts";

type SourceFile = { file: string; parseImports: boolean };
type SourceToken = { value: string; literal?: boolean; statementEnd?: boolean };
const CONSERVATIVE_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`]*?\s+from\s+)?["'`]([^"'`]+)["'`]|\b(?:import(?:\.meta\.resolve)?|require(?:\.resolve)?)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|\bnew\s+URL\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*,?\s*\)/gu;

// The pre-install scan cannot load TypeScript. Token boundaries keep source fixtures,
// comments, and template text from becoming executable import edges.
function sourceTokens(source: string): {
  tokens: SourceToken[];
  uncertain: boolean;
  possibleJsx: boolean;
} {
  const tokens: SourceToken[] = [];
  let uncertain = false;
  let possibleJsx = false;
  const escapes: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  };
  const whitespace = /\s+/uy;
  const word = /[\w$]+/uy;
  const jsxStart = /<\s*[\p{ID_Start}_$>/]/uy;
  const statementPrefix = (token: SourceToken | undefined) =>
    !token ||
    (!token.literal &&
      (token.statementEnd ||
        [";", "{", "export", "default", "else", "do", "try", "finally"].includes(token.value)));
  const declarationAt = (index: number) =>
    statementPrefix(tokens[tokens[index - 1]?.value === "async" ? index - 2 : index - 1]);
  let offset = 0;
  const quoted = (quote: string) => {
    let value = "";
    let closed = false;
    offset++;
    while (offset < source.length) {
      const char = source[offset++]!;
      if (char === quote) {
        closed = true;
        break;
      }
      if (char === "\n" || char === "\r") {
        break;
      }
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escaped = source[offset++] ?? "";
      if (escaped === "\n" || escaped === "\r") {
        if (escaped === "\r" && source[offset] === "\n") {
          offset++;
        }
      } else if (escaped === "u" || escaped === "x") {
        const codepoint = escaped === "u" && source[offset] === "{";
        const end = codepoint ? source.indexOf("}", offset) : offset + (escaped === "u" ? 4 : 2);
        const digits = source.slice(offset + Number(codepoint), end);
        if (end >= offset && /^[0-9a-f]+$/iu.test(digits)) {
          value += String.fromCodePoint(Number.parseInt(digits, 16));
          offset = end + Number(codepoint);
        }
      } else {
        value += escapes[escaped] ?? escaped;
      }
    }
    uncertain ||= !closed;
    return value;
  };
  const scan = (interpolation = false): void => {
    const braces: boolean[] = [];
    const parentheses: Array<
      "control" | "function-declaration" | "function-expression" | undefined
    > = [];
    const classes: Array<{ braces: number; parentheses: number; declaration: boolean }> = [];
    let functionBody: boolean | undefined;
    while (offset < source.length) {
      const char = source[offset]!;
      if (/\s/u.test(char)) {
        whitespace.lastIndex = offset;
        whitespace.exec(source);
        offset = whitespace.lastIndex;
        continue;
      }
      if (source.startsWith("//", offset)) {
        const end = source.indexOf("\n", offset);
        offset = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("/*", offset)) {
        const end = source.indexOf("*/", offset + 2);
        offset = end < 0 ? source.length : end + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        tokens.push({ value: quoted(char), literal: true });
        continue;
      }
      if (char === "`") {
        const before = tokens.length;
        let text = "";
        let expressions = false;
        offset++;
        while (offset < source.length && source[offset] !== "`") {
          if (source[offset] === "\\") {
            text += source.slice(offset, offset + 2);
            offset += 2;
          } else if (source.startsWith("${", offset)) {
            expressions = true;
            tokens.push({ value: ";" });
            offset += 2;
            scan(true);
            tokens.push({ value: ";" });
          } else {
            text += source[offset++];
          }
        }
        uncertain ||= source[offset] !== "`";
        offset++;
        if (!expressions) {
          tokens.push({ value: text, literal: true });
        } else {
          tokens.splice(before, 0, { value: ";" });
        }
        continue;
      }
      // Regex literals cannot contain executable imports. At expression starts,
      // skip escaped characters and character classes through the closing slash.
      const previous = tokens.at(-1);
      const startsExpression =
        !previous ||
        (!previous.literal &&
          (previous.statementEnd ||
            /^(?:[=(:,;!&|?{[+*%<>^~/-]|=>|return|throw|case|yield|await|typeof|void|delete|in|instanceof|of|else|do)$/u.test(
              previous.value,
            )));
      if (char === "<" && (startsExpression || previous?.value === "default")) {
        // JSX text and closing tags can hide imports behind apparent comments or regexps.
        jsxStart.lastIndex = offset;
        possibleJsx ||= jsxStart.test(source);
      }
      if (char === "/" && startsExpression) {
        offset++;
        let characterClass = false;
        while (offset < source.length) {
          const current = source[offset++]!;
          if (current === "\\") {
            offset++;
          } else if (current === "[") {
            characterClass = true;
          } else if (current === "]") {
            characterClass = false;
          } else if (current === "/" && !characterClass) {
            break;
          } else if (current === "\n" || current === "\r") {
            break;
          }
        }
        tokens.push({ value: "<regexp>" });
        continue;
      }
      if (char === "}" && interpolation && braces.length === 0) {
        offset++;
        return;
      }
      if (char === "(") {
        let functionIndex = tokens.length - 1;
        while (
          functionIndex >= 0 &&
          !["function", ";", "{", "}", "(", "=", "=>"].includes(tokens[functionIndex]!.value)
        ) {
          functionIndex--;
        }
        const functionHead =
          tokens[functionIndex]?.value === "function" && tokens[functionIndex - 1]?.value !== ".";
        const controlHead =
          ["if", "while", "for", "switch", "with", "catch"].includes(previous?.value ?? "") &&
          tokens.at(-2)?.value !== ".";
        parentheses.push(
          controlHead
            ? "control"
            : functionHead
              ? declarationAt(functionIndex)
                ? "function-declaration"
                : "function-expression"
              : undefined,
        );
      } else if (char === ")") {
        const context = parentheses.pop();
        if (context?.startsWith("function-")) {
          functionBody = context === "function-declaration";
        }
        tokens.push({ value: char, statementEnd: context === "control" });
        offset++;
        continue;
      } else if (char === "{") {
        const classBody = classes.at(-1);
        const startsClass =
          functionBody === undefined &&
          classBody?.braces === braces.length &&
          classBody.parentheses === parentheses.length;
        const statement =
          functionBody ??
          (startsClass
            ? classes.pop()!.declaration
            : previous?.value !== "=>" && statementPrefix(previous));
        braces.push(statement);
        functionBody = undefined;
      } else if (char === "}") {
        tokens.push({ value: char, statementEnd: braces.pop() === true });
        offset++;
        continue;
      } else if (char === ";") {
        functionBody = undefined;
        while (
          classes.at(-1)?.braces === braces.length &&
          classes.at(-1)?.parentheses === parentheses.length
        ) {
          classes.pop();
        }
      }
      if (/[\w$]/u.test(char)) {
        const start = offset;
        word.lastIndex = offset;
        word.exec(source);
        offset = word.lastIndex;
        const value = source.slice(start, offset);
        if (value === "class" && previous?.value !== ".") {
          classes.push({
            braces: braces.length,
            parentheses: parentheses.length,
            declaration: declarationAt(tokens.length),
          });
        }
        tokens.push({ value });
      } else {
        // Postfix updates end an operand; arrows start an expression or a function body.
        const operator = source.slice(offset, offset + 2);
        const value = ["=>", "++", "--"].includes(operator) ? operator : char;
        tokens.push({ value });
        offset += value.length;
      }
    }
  };
  scan();
  return { tokens, uncertain, possibleJsx };
}

function importFacts(
  source: string,
  classifyTypes = true,
): { imports: string[]; typeOnlyImports: string[] } {
  const { tokens, uncertain, possibleJsx } = sourceTokens(source);
  let runtimeSource: string | undefined;
  let unresolvedJsx = false;
  if (possibleJsx && !uncertain && classifyTypes) {
    try {
      // Valid TypeScript generics/comparisons need no widening. Node rejects JSX.
      runtimeSource = nodeModule.stripTypeScriptTypes(source, { mode: "strip" });
    } catch {
      unresolvedJsx = true;
    }
  }
  const imports = new Set<string>();
  let needsTypeStrip = false;
  const add = (token: SourceToken | undefined, fileUrl = false) => {
    if (token?.literal) {
      const specifier = fileUrl ? token.value.replace(/[?#].*$/u, "") : token.value;
      imports.add(specifier);
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.literal) {
      continue;
    }
    const next = (step: number) => tokens[index + step]?.value;
    if (token.value === "new" && next(1) === "URL" && next(2) === "(") {
      if (
        [",", "import", ".", "meta", ".", "url"].every((value, step) => next(step + 4) === value)
      ) {
        add(tokens[index + 3], true);
      }
      continue;
    }
    if (token.value === "require" && next(1) === "." && next(2) === "resolve" && next(3) === "(") {
      add(tokens[index + 4]);
      continue;
    }
    if (
      token.value === "import" &&
      next(1) === "." &&
      next(2) === "meta" &&
      next(3) === "." &&
      next(4) === "resolve" &&
      next(5) === "("
    ) {
      add(tokens[index + 6]);
      continue;
    }
    if ((token.value === "import" || token.value === "require") && next(1) === "(") {
      needsTypeStrip ||= token.value === "import";
      add(tokens[index + 2]);
      continue;
    }
    if (token.value !== "import" && token.value !== "export") {
      continue;
    }
    if (next(1) === "." || next(1) === "(" || tokens[index - 1]?.value === ".") {
      continue;
    }
    if (token.value === "import" && tokens[index + 1]?.literal) {
      add(tokens[index + 1]);
      continue;
    }
    if (token.value === "export" && !["type", "*", "{"].includes(next(1) ?? "")) {
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const current = tokens[cursor]!;
      if ([";", "=", "import", "export"].includes(current.value) && !current.literal) {
        break;
      }
      if (current.value !== "from" || current.literal || !tokens[cursor + 1]?.literal) {
        continue;
      }
      needsTypeStrip ||= next(1) === "type";
      add(tokens[cursor + 1]);
      break;
    }
  }
  if (uncertain || unresolvedJsx) {
    // JSX or a quote swallowed by an unfamiliar regex context is not proof of no
    // imports. Retain the broad literal scan, including possible fixture edges.
    for (const match of source.matchAll(CONSERVATIVE_IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3]?.replace(/[?#].*$/u, "");
      if (specifier) {
        imports.add(specifier);
      }
    }
    return { imports: [...imports], typeOnlyImports: [] };
  }
  if (!classifyTypes || (!needsTypeStrip && runtimeSource === undefined)) {
    return { imports: [...imports], typeOnlyImports: [] };
  }
  try {
    // Node's parser distinguishes import types from calls and preserves named
    // type-import side effects, matching this repo's verbatimModuleSyntax contract.
    runtimeSource ??= nodeModule.stripTypeScriptTypes(source, { mode: "strip" });
  } catch {
    // JSX and transform-required syntax remain conservatively connected.
    return { imports: [...imports], typeOnlyImports: [] };
  }
  const runtime = new Set(importFacts(runtimeSource, false).imports);
  return {
    imports: [...imports],
    typeOnlyImports: [...imports].filter((specifier) => !runtime.has(specifier)),
  };
}

function configuredRuntimeImports(source: string, file: string): string[] {
  if (
    !/(?:^|\/)vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s$/u.test(file) &&
    !(file.startsWith("test/vitest/") && /(?:^|[.-])config\.[cm]?[jt]s$/u.test(file))
  ) {
    return [];
  }
  const { tokens } = sourceTokens(source);
  const imports = new Set<string>();
  const expression = (start: number) => {
    let depth = 0;
    let end = start;
    for (; end < tokens.length; end++) {
      const token = tokens[end]!;
      if (token.literal) {
        continue;
      }
      if (depth === 0 && [",", ";", "}", "]", ")"].includes(token.value)) {
        break;
      }
      if (["(", "[", "{"].includes(token.value)) {
        depth++;
      } else if ([")", "]", "}"].includes(token.value)) {
        depth--;
      }
    }
    return tokens.slice(start, end);
  };
  const bindings = new Map<string, SourceToken[]>();
  for (let index = 0; index < tokens.length; index++) {
    if (
      !tokens[index]!.literal &&
      ["const", "let", "var"].includes(tokens[index]!.value) &&
      tokens[index + 2]?.value === "="
    ) {
      bindings.set(tokens[index + 1]!.value, expression(index + 3));
    }
  }
  const addFile = (filePath: string, root = file.startsWith("ui/") ? "ui" : ".") => {
    if (!/\.[cm]?[jt]sx?$/u.test(filePath) || /[*?$]/u.test(filePath)) {
      return;
    }
    const target = path.posix.normalize(path.posix.join(root, filePath));
    if (target.startsWith("../") || path.posix.isAbsolute(target)) {
      return;
    }
    const relative = path.posix.relative(path.posix.dirname(file), target);
    imports.add(relative.startsWith(".") ? relative : `./${relative}`);
  };
  const seen = new Set<string>();
  const visit = (parts: SourceToken[]) => {
    for (let index = 0; index < parts.length; index++) {
      const token = parts[index]!;
      if (token.literal) {
        if (token.value.startsWith(".")) {
          addFile(token.value);
        } else if (/^(?:test|ui|src|extensions|packages|scripts)\//u.test(token.value)) {
          addFile(token.value, ".");
        }
        continue;
      }
      if (
        ["join", "resolve"].includes(token.value) &&
        parts[index - 1]?.value === "." &&
        parts[index + 1]?.value === "(" &&
        ["repoRoot", "here", "__dirname"].includes(parts[index + 2]?.value ?? "")
      ) {
        const segments: string[] = [];
        let cursor = index + 3;
        while (parts[cursor]?.value === "," && parts[cursor + 1]?.literal) {
          segments.push(parts[cursor + 1]!.value);
          cursor += 2;
        }
        if (
          segments.length > 0 &&
          (parts[cursor]?.value === ")" ||
            (parts[cursor]?.value === "," && parts[cursor + 1]?.value === ")"))
        ) {
          addFile(
            path.posix.join(...segments),
            parts[index + 2]!.value === "repoRoot" ? "." : path.posix.dirname(file),
          );
        }
      }
      const binding = bindings.get(token.value);
      if (binding && !seen.has(token.value)) {
        seen.add(token.value);
        visit(binding);
      }
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const key = tokens[index]!.value;
    if (tokens[index + 1]?.value !== ":") {
      continue;
    }
    if (["setupFiles", "globalSetup", "runner"].includes(key)) {
      visit(expression(index + 2));
    } else if (key === "environment" && tokens[index + 2]?.literal) {
      const environment = tokens[index + 2]!.value;
      if (["jsdom", "happy-dom"].includes(environment)) {
        imports.add(environment);
      }
    }
  }
  return [...imports];
}

/** Proves runtime emptiness for module source; callers retain compiler and policy owners. */
export function isErasedTypeScriptModuleSource(source: string): boolean {
  const original = sourceTokens(source);
  if (
    original.uncertain ||
    original.tokens.some((token) => !token.literal && token.value === "declare") ||
    /^\s*\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b/mu.test(source)
  ) {
    return false;
  }
  let runtime: ReturnType<typeof sourceTokens>;
  try {
    runtime = sourceTokens(nodeModule.stripTypeScriptTypes(source, { mode: "strip" }));
  } catch {
    return false;
  }
  if (runtime.uncertain) {
    return false;
  }
  if (runtime.tokens.length === 0) {
    return true;
  }
  // Under the repository's ESM contract, export {} only marks the module.
  const values = runtime.tokens.map((token) => (token.literal ? undefined : token.value));
  return (
    (values.length === 3 || (values.length === 4 && values[3] === ";")) &&
    values[0] === "export" &&
    values[1] === "{" &&
    values[2] === "}"
  );
}

/** Missing history cannot establish a type-only addition or removal of runtime code. */
export function isErasedTypeScriptFileChange(
  cwd: string,
  file: string,
  baseRef: string | undefined,
): boolean {
  if (
    !baseRef ||
    !/^[a-f0-9]{40}$/u.test(baseRef) ||
    !file.endsWith(".ts") ||
    file.endsWith(".d.ts") ||
    path.posix.normalize(file) !== file ||
    file.startsWith("../") ||
    path.isAbsolute(file)
  ) {
    return false;
  }
  try {
    const current = path.join(cwd, file);
    if (
      !lstatSync(current, { throwIfNoEntry: false })?.isFile() ||
      !isErasedTypeScriptModuleSource(readFileSync(current, "utf8"))
    ) {
      return false;
    }
    const git = (args: string[]) => {
      const result = spawnSync("git", ["--literal-pathspecs", ...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0 || result.error) {
        throw new Error("TypeScript source history is unavailable");
      }
      return result.stdout;
    };
    if (
      git(["ls-files", "-z", "--", file]) !== `${file}\0` ||
      git(["cat-file", "-t", baseRef]).trim() !== "commit"
    ) {
      return false;
    }
    const entries = git(["ls-tree", "-z", baseRef, "--", file]).split("\0").filter(Boolean);
    if (entries.length === 0) {
      return true;
    }
    if (entries.length !== 1) {
      return false;
    }
    const entry = entries[0]!;
    const separator = entry.indexOf("\t");
    const blob = /^(?:100644|100755) blob ([a-f0-9]{40})$/u.exec(entry.slice(0, separator));
    return (
      entry.slice(separator + 1) === file &&
      blob !== null &&
      isErasedTypeScriptModuleSource(git(["cat-file", "blob", blob[1]!]))
    );
  } catch {
    return false;
  }
}

function parseStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new Error("Expected a string array in test selector source scan");
  }
  return value;
}

function parseFacts(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("imports" in value) ||
    !("typeOnlyImports" in value) ||
    !("matches" in value) ||
    !("references" in value)
  ) {
    throw new Error("Invalid test selector source facts");
  }
  return {
    imports: parseStrings(value.imports),
    typeOnlyImports: parseStrings(value.typeOnlyImports),
    matches: parseStrings(value.matches),
    references: parseStrings(value.references),
  };
}

/** Acquires complete JS-parsed facts with bounded asynchronous reads, joining one native child. */
export function readTestSelectorSourceFacts(
  cwd: string,
  files: SourceFile[],
  terms: string[],
  maxBuffer: number,
) {
  if (files.length === 0) {
    return [];
  }
  // The selector API is synchronous. A finite child owns the async reads and
  // exits before we return; inheriting loader hooks would reintroduce tsx work.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const executable = resolveNodeRuntimeExecutable({ env });
  if (!executable) {
    throw new Error("A Node executable is required for test selection; add node to PATH.");
  }
  const result = spawnSync(executable, [fileURLToPath(import.meta.url)], {
    cwd,
    env,
    input: JSON.stringify({ files, terms }),
    encoding: "utf8",
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(
      `Test selector source scan failed (${result.signal ?? result.status}): ${result.stderr}`,
      { cause: result.error },
    );
  }
  // Position is the file identity: require every requested row, including unreadable files.
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== files.length) {
    throw new Error("Invalid test selector source scan row count");
  }
  return rows.flatMap((row: unknown, index) =>
    row === null ? [] : [{ file: files[index]!.file, ...parseFacts(row) }],
  );
}

async function readSourceFacts() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const request: unknown = JSON.parse(input);
  if (
    !request ||
    typeof request !== "object" ||
    !("files" in request) ||
    !Array.isArray(request.files) ||
    !("terms" in request)
  ) {
    throw new Error("Invalid test selector source scan request");
  }
  const files = request.files.map((value: unknown): SourceFile => {
    if (
      !value ||
      typeof value !== "object" ||
      !("file" in value) ||
      typeof value.file !== "string" ||
      !("parseImports" in value) ||
      typeof value.parseImports !== "boolean"
    ) {
      throw new Error("Invalid test selector source scan file");
    }
    return { file: value.file, parseImports: value.parseImports };
  });
  const matchTerms = createSourceTermMatcher(parseStrings(request.terms));
  const readFacts = async ({ file, parseImports }: SourceFile) => {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      // Git inventories include deleted files; preserve the selector's unreadable-file behavior.
      return null;
    }
    const { matches, references } = matchTerms(source);
    const facts = parseImports ? importFacts(source) : { imports: [], typeOnlyImports: [] };
    if (parseImports) {
      // Vitest loads these modules from config values instead of JavaScript imports.
      const configured = new Set(configuredRuntimeImports(source, file));
      facts.imports = [...new Set([...facts.imports, ...configured])];
      facts.typeOnlyImports = facts.typeOnlyImports.filter(
        (specifier) => !configured.has(specifier),
      );
    }
    return {
      ...facts,
      matches,
      references,
    };
  };
  const facts: (ReturnType<typeof parseFacts> | null)[] = files.map(() => null);
  const failures: unknown[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(32, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        try {
          facts[index] = await readFacts(files[index]!);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  // Join every read, including after a scan failure, before publishing or failing.
  if (failures.length > 0) {
    throw new AggregateError(failures, "Test selector source scan failed");
  }
  process.stdout.write(JSON.stringify(facts));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await readSourceFacts();
  } catch (error) {
    console.error(error);
    console.error("[test-selector-source-facts] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
