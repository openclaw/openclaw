import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ContextScriptEntry {
  id: string;
  uri: string;
  format?: "json" | "arguments";
  method?: string;
  priority?: number;
  position?: "append" | "prepend";
  log?: boolean | "verbose";
  errorHandling?: "continue" | "stop";
  returnKey?: string;
  errorKey?: string;
  agentIdOverrideKey?: string;
  argMap?: Record<string, string>;
}

export interface ResolvedScript {
  id: string;
  uri: string;
  format: "json" | "arguments";
  method?: string;
  priority: number;
  position: "append" | "prepend";
  log: false | true | "verbose";
  errorHandling: "continue" | "stop";
  returnKey?: string;
  errorKey?: string;
  agentIdOverrideKey?: string;
  argMap?: Record<string, string>;
}

export function resolveContextScripts(
  defaultScripts: ContextScriptEntry[],
  agentScripts: ContextScriptEntry[],
  agentIgnore: string[],
): ResolvedScript[] {
  const ignoreSet = new Set(agentIgnore);

  // Filter defaultScripts — remove any where script.id is in agentIgnore set
  const filteredDefaults = defaultScripts.filter((script) => !ignoreSet.has(script.id));

  // Merge: [...filteredDefaults, ...agentScripts]
  const merged = [...filteredDefaults, ...agentScripts];

  // Dedupe by id — last occurrence wins (agent scripts override defaults with same id)
  const dedupMap = new Map<string, ContextScriptEntry>();
  for (const script of merged) {
    dedupMap.set(script.id, script);
  }
  const deduped: ContextScriptEntry[] = Array.from(dedupMap.values());

  // Apply defaults for optional fields
  const resolved: ResolvedScript[] = deduped.map((script) => ({
    id: script.id,
    uri: script.uri,
    format: script.format ?? "arguments",
    method: script.method,
    priority: script.priority ?? 0,
    position: script.position ?? "append",
    log: script.log ?? false,
    errorHandling: script.errorHandling ?? "continue",
    returnKey: script.returnKey,
    errorKey: script.errorKey,
    agentIdOverrideKey: script.agentIdOverrideKey,
    argMap: script.argMap,
  }));

  // Sort by priority descending (highest first). Stable sort.
  resolved.sort((a, b) => b.priority - a.priority);

  return resolved;
}

/**
 * Execute resolved context scripts and return prepend/append content + optional agentId override.
 *
 * @param validateAgentId - Optional validator function. When provided, override candidates are
 *   checked against it; only candidates that return true are eligible. If no validator is given,
 *   all overrides are accepted (first wins by priority order).
 */
export async function executeContextScripts(
  scripts: ResolvedScript[],
  variables: Record<string, unknown>,
  validateAgentId?: (agentId: string) => boolean,
): Promise<{ prepend: string; append: string; agentIdOverride?: string }> {
  const prepend: string[] = [];
  const append: string[] = [];

  interface OverrideCandidate {
    scriptId: string;
    agentId: string;
    priority: number;
  }
  const overrideCandidates: OverrideCandidate[] = [];

  for (const script of scripts) {
    try {
      const result = await executeScriptWithMetadata(script, variables);

      if (script.log) {
        console.log(
          `[context-script] ${script.id} (${script.uri}) → ${result.output.length} chars`,
        );
        if (script.log === "verbose") {
          const argDesc = script.argMap
            ? Object.entries(script.argMap)
                .map(([k, v]) => `${k}=${JSON.stringify(variables[v])}`)
                .join(" ")
            : "(no args)";
          console.log(`[context-script] ${script.id} command: ${script.uri} ${argDesc}`);
          console.log(`[context-script] ${script.id} output:\n${result.output}`);
        }
      }

      if (result.agentIdOverride) {
        overrideCandidates.push({
          scriptId: script.id,
          agentId: result.agentIdOverride,
          priority: script.priority,
        });
        if (script.log === "verbose") {
          console.log(
            `[context-script] ${script.id} proposed agentIdOverride: ${result.agentIdOverride}`,
          );
        }
      }

      if (result.output) {
        if (script.position === "prepend") {
          prepend.push(result.output);
        } else {
          append.push(result.output);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[context-script] ${script.id} failed: ${errorMessage}`);

      if (script.errorHandling === "stop") {
        break;
      }
    }
  }

  // Resolve best agentId override: highest priority, validated
  let agentIdOverride: string | undefined;
  if (overrideCandidates.length > 0) {
    // Already sorted by priority (scripts run in priority order), so iterate in order
    const winner = validateAgentId
      ? overrideCandidates.find((c) => validateAgentId(c.agentId))
      : overrideCandidates[0];

    if (winner) {
      agentIdOverride = winner.agentId;
    }

    // Log resolution in verbose mode (check any script with verbose logging)
    const anyVerbose = scripts.some((s) => s.log === "verbose");
    if (anyVerbose) {
      const candidateDesc = overrideCandidates
        .map(
          (c) =>
            `${c.scriptId}→${c.agentId} (pri:${c.priority}${validateAgentId ? (validateAgentId(c.agentId) ? " ✓" : " ✗") : ""})`,
        )
        .join(", ");
      console.log(
        `[context-script] agentIdOverride candidates: [${candidateDesc}]` +
          (winner ? ` → winner: ${winner.scriptId}→${winner.agentId}` : " → none valid"),
      );
    }
  }

  return {
    prepend: prepend.join("\n\n"),
    append: append.join("\n\n"),
    agentIdOverride,
  };
}

async function executeScriptWithMetadata(
  script: ResolvedScript,
  variables: Record<string, unknown>,
): Promise<{ output: string; agentIdOverride?: string }> {
  const rawOutput = await executeScriptRaw(script, variables);

  // If agentIdOverrideKey is set, try to extract it from JSON before parsing
  let agentIdOverride: string | undefined;
  if (script.agentIdOverrideKey && rawOutput) {
    try {
      const parsed = JSON.parse(rawOutput);
      if (typeof parsed === "object" && parsed !== null && script.agentIdOverrideKey in parsed) {
        const val = (parsed as Record<string, unknown>)[script.agentIdOverrideKey];
        if (typeof val === "string" && val.trim()) {
          agentIdOverride = val.trim();
        }
      }
    } catch {
      // Not JSON — no override possible
    }
  }

  const output = parseScriptOutput(rawOutput, script);
  return { output, agentIdOverride };
}

async function executeScriptRaw(
  script: ResolvedScript,
  variables: Record<string, unknown>,
): Promise<string> {
  // Build args from argMap
  const argObject: Record<string, unknown> = {};

  if (script.argMap) {
    for (const [key, varName] of Object.entries(script.argMap)) {
      argObject[key] = variables[varName];
    }
  }

  // Determine if URI is a file or HTTP
  const isHttp = script.uri.startsWith("http://") || script.uri.startsWith("https://");

  let output: string;

  if (isHttp) {
    output = await executeHttpScript(script, argObject);
  } else {
    output = await executeLocalScript(script, argObject);
  }

  return output;
}

/**
 * Parse script output through the response parsing pipeline:
 * 1. Plain text (not JSON) → use as-is
 * 2. JSON with errorKey → check for custom error field
 * 3. JSON error detection → standard patterns (error, errors, ok:false, status:"error")
 * 4. JSON with returnKey → extract specific key
 * 5. JSON without returnKey → auto-detect: message → content → text → result → stringify
 */
function parseScriptOutput(output: string, script: ResolvedScript): string {
  if (!output) {
    return "";
  }

  // Try to parse as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Not JSON — plain text, use as-is
    return output;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return output;
  }

  const obj = parsed as Record<string, unknown>;

  // Check custom errorKey first
  if (script.errorKey && obj[script.errorKey]) {
    const errorVal = obj[script.errorKey];
    const errorMsg = typeof errorVal === "string" ? errorVal : JSON.stringify(errorVal);
    throw new Error(`Script ${script.id} returned error (${script.errorKey}): ${errorMsg}`);
  }

  // Standard error detection patterns (OpenAI, Anthropic, REST conventions)
  detectStandardErrors(obj, script.id);

  // Extract content with returnKey
  if (script.returnKey) {
    if (script.returnKey in obj) {
      const extracted = obj[script.returnKey];
      return typeof extracted === "string" ? extracted : JSON.stringify(extracted);
    }
    throw new Error(`Script ${script.id}: returnKey "${script.returnKey}" not found in response`);
  }

  // Auto-detect content from standard fields
  const contentKeys = ["message", "content", "text", "result"];
  for (const key of contentKeys) {
    if (key in obj && obj[key] != null) {
      const val = obj[key];
      return typeof val === "string" ? val : JSON.stringify(val);
    }
  }

  // No standard field found — stringify the whole object
  return JSON.stringify(obj);
}

/**
 * Detect errors using standard API conventions:
 * - error (string or object with .message)
 * - errors (array)
 * - status === "error"
 * - ok === false
 */
function detectStandardErrors(obj: Record<string, unknown>, scriptId: string): void {
  // Check for error field
  if (obj.error) {
    if (typeof obj.error === "string") {
      throw new Error(`Script ${scriptId} returned error: ${obj.error}`);
    }
    if (typeof obj.error === "object" && obj.error !== null) {
      const errObj = obj.error as Record<string, unknown>;
      const msg = String(errObj.message ?? errObj.type ?? JSON.stringify(obj.error));
      throw new Error(`Script ${scriptId} returned error: ${msg}`);
    }
  }

  // Check for errors array
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const messages = obj.errors
      .map((e: unknown) => {
        if (typeof e === "string") {
          return e;
        }
        if (typeof e === "object" && e !== null && "message" in e) {
          return (e as Record<string, unknown>).message;
        }
        return JSON.stringify(e);
      })
      .join("; ");
    throw new Error(`Script ${scriptId} returned errors: ${messages}`);
  }

  // Check for status === "error"
  if (obj.status === "error") {
    const msg = typeof obj.message === "string" ? obj.message : "status=error";
    throw new Error(`Script ${scriptId} returned error: ${msg}`);
  }

  // Check for ok === false
  if (obj.ok === false) {
    const msg = typeof obj.message === "string" ? obj.message : "ok=false";
    throw new Error(`Script ${scriptId} returned error: ${msg}`);
  }
}

async function executeLocalScript(
  script: ResolvedScript,
  argObject: Record<string, unknown>,
): Promise<string> {
  // Resolve ~ in URI path
  let resolvedPath = script.uri;
  if (resolvedPath.startsWith("~/")) {
    resolvedPath = path.join(homedir(), resolvedPath.slice(2));
  } else if (resolvedPath === "~") {
    resolvedPath = homedir();
  }

  if (script.format === "arguments") {
    // Spawn the script with named key="value" arguments from argMap
    const args = Object.entries(argObject).map(([k, v]) => `${k}=${String(v ?? "")}`);
    const result = await execFileAsync(resolvedPath, args, {
      timeout: 10000,
      encoding: "utf-8",
    });
    return result.stdout.trim();
  } else {
    // format: "json" — pipe JSON to stdin
    const jsonInput = JSON.stringify(argObject);
    return await executeLocalScriptWithStdin(resolvedPath, jsonInput);
  }
}

function executeLocalScriptWithStdin(scriptPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let timeoutId: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorChunks.push(chunk);
    });

    child.on("error", (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (code !== 0) {
        const stderr = Buffer.concat(errorChunks).toString("utf-8");
        reject(new Error(`Script exited with code ${code}: ${stderr}`));
        return;
      }

      const stdout = Buffer.concat(chunks).toString("utf-8");
      resolve(stdout.trim());
    });

    // Set timeout
    timeoutId = setTimeout(() => {
      child.kill();
      reject(new Error("Script execution timed out after 10 seconds"));
    }, 10000);

    // Write input to stdin and close it
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function executeHttpScript(
  script: ResolvedScript,
  argObject: Record<string, unknown>,
): Promise<string> {
  const method = (script.method || "GET").toUpperCase();

  let url = script.uri;
  let body: string | undefined;
  const headers: Record<string, string> = {};

  if (method === "GET" && script.argMap && Object.keys(script.argMap).length > 0) {
    // GET: argMap values as query params
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(argObject)) {
      params.append(key, String(value));
    }
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}${params.toString()}`;
  } else if ((method === "POST" || method === "PUT") && script.argMap) {
    // POST/PUT: argMap as JSON body
    body = JSON.stringify(argObject);
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.text();
}
