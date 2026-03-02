/**
 * Generates TypeScript API declarations for the sandbox runtime.
 * These declarations are injected into the system prompt so the LLM
 * knows what functions are available inside execute_code.
 */

/** Description of a single API method available in the sandbox. */
type ApiMethodDoc = {
  name: string;
  signature: string;
  description: string;
};

const SANDBOX_API_METHODS: ApiMethodDoc[] = [
  {
    name: "readFile",
    signature: "(path: string): Promise<string>",
    description: "Read a file's contents as UTF-8 text. Path is relative to the workspace root.",
  },
  {
    name: "writeFile",
    signature: "(path: string, content: string): Promise<void>",
    description:
      "Write content to a file (creates or overwrites). Path is relative to the workspace root.",
  },
  {
    name: "listFiles",
    signature: "(glob: string): Promise<string[]>",
    description:
      "List files matching a glob pattern (e.g. '**/*.ts'). Returns paths relative to the workspace root.",
  },
  {
    name: "exec",
    signature:
      "(command: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>",
    description:
      "Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code.",
  },
  {
    name: "fetch",
    signature:
      "(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string; headers: Record<string, string> }>",
    description: "Make an HTTP request. Only available when network access is enabled.",
  },
  {
    name: "log",
    signature: "(...args: unknown[]): void",
    description: "Log a message. Logged messages are included in the tool result for debugging.",
  },
];

/**
 * Generate the TypeScript API declaration block injected into the system prompt.
 * This tells the LLM what's available inside the execute_code sandbox.
 */
export function generateApiDeclarations(opts: { allowNetwork: boolean }): string {
  const methods = opts.allowNetwork
    ? SANDBOX_API_METHODS
    : SANDBOX_API_METHODS.filter((m) => m.name !== "fetch");

  const lines: string[] = [
    "// Available API inside execute_code. All methods are on the global `api` object.",
    "declare const api: {",
  ];

  for (const method of methods) {
    lines.push(`  /** ${method.description} */`);
    lines.push(`  ${method.name}${method.signature};`);
  }

  lines.push("};");
  return lines.join("\n");
}

/**
 * Build the full code-mode context block that gets prepended to the system prompt.
 */
export function buildCodeModeContext(opts: { allowNetwork: boolean }): string {
  const declarations = generateApiDeclarations(opts);
  return [
    "<code-mode>",
    "You have access to an `execute_code` tool that runs TypeScript code in a sandbox.",
    "When a task requires multiple steps (reading files, running commands, processing data),",
    "prefer writing a single TypeScript program via execute_code instead of calling tools one at a time.",
    "",
    "The sandbox provides the following typed API on the global `api` object:",
    "",
    "```typescript",
    declarations,
    "```",
    "",
    "Your code runs in an async context. The last expression's value is returned as the tool result.",
    "Use `api.log()` for intermediate output. Prefer structured return values (objects/arrays).",
    "</code-mode>",
  ].join("\n");
}
