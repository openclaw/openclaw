const FILE_PATH_RE = /(?:\/[\w./-]+|[A-Za-z]:\\[\w.\\/-]+)/g;
const ERROR_RE = /(?:error|Error|ERROR|exception|Exception|EXCEPTION|fail(?:ed|ure)?|FAIL)[:. ].{0,100}/g;
const EXPORT_RE = /export\s+(?:default\s+)?(?:function|class|const|let|type|interface|enum)\s+(\w+)/g;

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TSX",
  ".js": "JavaScript",
  ".jsx": "JSX",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".rb": "Ruby",
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".md": "Markdown",
  ".html": "HTML",
  ".css": "CSS",
  ".sh": "Shell",
  ".sql": "SQL",
};

function detectLanguage(args: string): string | undefined {
  // Try to extract file extension from args (file path in read/grep tools)
  const pathMatch = args.match(/["']?([^"'\s]+\.\w{1,6})["']?/);
  if (pathMatch) {
    const ext = pathMatch[1].slice(pathMatch[1].lastIndexOf(".")).toLowerCase();
    return EXT_TO_LANG[ext];
  }
  return undefined;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function firstNLines(text: string, n: number): string {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length && lines.length < n; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (lines.length < n && start < text.length) {
    lines.push(text.slice(start));
  }
  return lines.join("\n");
}

function lastLine(text: string): string {
  const idx = text.lastIndexOf("\n");
  return idx === -1 ? text : text.slice(idx + 1);
}

function extractExports(content: string, max: number): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((match = EXPORT_RE.exec(content)) !== null && names.length < max) {
    names.push(match[1]);
  }
  return names;
}

function extractFilePaths(content: string, max: number): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;
  while ((match = FILE_PATH_RE.exec(content)) !== null && paths.length < max) {
    paths.push(match[0]);
  }
  return paths;
}

function extractErrors(content: string, max: number): string[] {
  const errors: string[] = [];
  let match: RegExpExecArray | null;
  ERROR_RE.lastIndex = 0;
  while ((match = ERROR_RE.exec(content)) !== null && errors.length < max) {
    errors.push(match[0].trim());
  }
  return errors;
}

const READ_TOOLS = new Set(["Read", "cat", "read_file", "ReadFile"]);
const SEARCH_TOOLS = new Set(["Grep", "grep", "rg", "search", "Search", "Glob", "glob", "find"]);
const EXEC_TOOLS = new Set(["Bash", "bash", "exec", "run", "shell", "Execute"]);

/**
 * Generate a heuristic hint from tool result content without LLM calls.
 * The hint is a short text summarizing the content for context window display.
 */
export function generateHeuristicHint(params: {
  toolName: string;
  args: string;
  content: string;
  maxHintChars?: number;
}): string {
  const { toolName, args, content, maxHintChars = 200 } = params;
  const lines = countLines(content);

  let hint: string;

  if (READ_TOOLS.has(toolName)) {
    // File read: show line count, language, first few lines, exports
    const lang = detectLanguage(args);
    const langTag = lang ? `, ${lang}` : "";
    const exports = extractExports(content, 5);
    const exportTag = exports.length > 0 ? `. Exports: ${exports.join(", ")}` : "";
    const preview = firstNLines(content, 2).trim();
    hint = `[${lines} lines${langTag}] ${preview}${exportTag}`;
  } else if (SEARCH_TOOLS.has(toolName)) {
    // Search results: match count, first few file paths
    const paths = extractFilePaths(content, 4);
    const pathTag = paths.length > 0 ? ` Files: ${paths.join(", ")}` : "";
    hint = `[${lines} result lines]${pathTag}`;
  } else if (EXEC_TOOLS.has(toolName)) {
    // Exec: exit code + first/last lines
    const exitMatch = content.match(/exit code[:\s]*(\d+)/i);
    const exitTag = exitMatch ? `exit ${exitMatch[1]}, ` : "";
    const first = firstNLines(content, 1).trim();
    const last = lastLine(content).trim();
    const body = first === last ? first : `${first} ... ${last}`;
    hint = `[${exitTag}${lines} lines] ${body}`;
  } else {
    // Default: first 2 lines + stats
    const preview = firstNLines(content, 2).trim();
    const errors = extractErrors(content, 2);
    const errorTag = errors.length > 0 ? ` Errors: ${errors.join("; ")}` : "";
    const paths = extractFilePaths(content, 3);
    const pathTag = paths.length > 0 && errors.length === 0 ? ` Paths: ${paths.join(", ")}` : "";
    hint = `[${lines} lines, ${content.length} chars] ${preview}${errorTag}${pathTag}`;
  }

  if (hint.length > maxHintChars) {
    return hint.slice(0, maxHintChars - 3) + "...";
  }
  return hint;
}
