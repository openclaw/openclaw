/**
 * Sandbox execution engine.
 *
 * Runs agent-written JavaScript code in a vm context with a controlled
 * `api` object that bridges file I/O, shell execution, glob, grep, and
 * optional HTTP requests back to the host process.
 *
 * IMPORTANT — NOT A SECURITY BOUNDARY
 * ====================================
 * Node's `vm` module does NOT provide security isolation. Untrusted code
 * can escape via `this.constructor.constructor("return this")()` and
 * similar techniques. This sandbox is a **convenience tool** that gives
 * the agent a structured API with workspace-scoped file I/O — it is not
 * a security sandbox. Since `api.exec()` already grants full shell
 * access (matching the agent's existing tool set), the vm context simply
 * constrains the *default scope*, not the trust boundary.
 */

import { exec as execCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";

const execAsync = promisify(execCb);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB per API response
const MAX_LIST_ENTRIES = 1000;

export type SandboxOptions = {
  workspaceDir: string;
  timeoutMs?: number;
  allowNetwork?: boolean;
};

export type SandboxResult = {
  success: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
};

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

/**
 * Resolve a user-provided path against the workspace directory,
 * rejecting any path traversal outside the workspace root.
 *
 * When `checkRealpath` is true (default for reads), follows symlinks
 * via `fs.realpath` and re-checks the prefix to defeat symlink-based
 * traversal. For writes where the file may not exist yet, the parent
 * directory's realpath is checked instead.
 */
async function resolveSecurePath(
  workspaceDir: string,
  userPath: string,
  opts?: { checkRealpath?: boolean; isWrite?: boolean },
): Promise<string> {
  const resolved = path.resolve(workspaceDir, userPath);
  if (!resolved.startsWith(workspaceDir + path.sep) && resolved !== workspaceDir) {
    throw new Error(`Path traversal blocked: ${userPath}`);
  }

  const shouldCheckRealpath = opts?.checkRealpath !== false;
  if (shouldCheckRealpath) {
    try {
      // Resolve workspaceDir itself to handle cases where it contains symlinks
      // (e.g. macOS /var -> /private/var)
      const realWorkspace = await fs.realpath(workspaceDir);

      if (opts?.isWrite) {
        // For writes the file (and intermediate dirs) may not exist —
        // walk up to the first existing ancestor and realpath-check that.
        // This prevents symlink-based traversal where mkdir would follow
        // a symlink and create directories outside the workspace.
        let ancestor = path.dirname(resolved);
        while (ancestor !== workspaceDir && ancestor !== path.dirname(ancestor)) {
          try {
            await fs.stat(ancestor);
            break; // exists — check its realpath below
          } catch {
            ancestor = path.dirname(ancestor);
          }
        }
        const realAncestor = await fs.realpath(ancestor);
        if (!realAncestor.startsWith(realWorkspace + path.sep) && realAncestor !== realWorkspace) {
          throw new Error(`Path traversal blocked (symlink): ${userPath}`);
        }
      } else {
        const realResolved = await fs.realpath(resolved);
        if (!realResolved.startsWith(realWorkspace + path.sep) && realResolved !== realWorkspace) {
          throw new Error(`Path traversal blocked (symlink): ${userPath}`);
        }
      }
    } catch (err) {
      // Re-throw traversal errors; for ENOENT on reads the subsequent
      // read call will produce the real error.
      if (err instanceof Error && err.message.startsWith("Path traversal blocked")) {
        throw err;
      }
    }
  }

  return resolved;
}

function truncateString(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) {
    return s;
  }
  const buf = Buffer.from(s, "utf8").subarray(0, maxBytes);
  return buf.toString("utf8") + "\n[truncated]";
}

// ---------------------------------------------------------------------------
// API method implementations
// ---------------------------------------------------------------------------

function buildApiHandlers(opts: SandboxOptions, logs: string[]) {
  const { workspaceDir, allowNetwork } = opts;

  return {
    async readFile(filePath: string): Promise<string> {
      const resolved = await resolveSecurePath(workspaceDir, String(filePath));
      const content = await fs.readFile(resolved, "utf8");
      return truncateString(content, MAX_OUTPUT_BYTES);
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      const resolved = await resolveSecurePath(workspaceDir, String(filePath), { isWrite: true });
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, String(content), "utf8");
    },

    async listFiles(pattern: string): Promise<string[]> {
      const glob = String(pattern || "*");
      const results: string[] = [];
      // Node 22+ fs.glob — use dynamic import to avoid hard failure on older builds
      try {
        const { glob: globFn } = await import("node:fs/promises");
        if (typeof globFn === "function") {
          for await (const entry of globFn(glob, { cwd: workspaceDir })) {
            results.push(entry);
            if (results.length >= MAX_LIST_ENTRIES) {
              break;
            }
          }
          return results;
        }
      } catch {
        // fs.glob not available — fall through to readdir
      }
      // Fallback: simple readdir (no recursive glob)
      const entries = await fs.readdir(workspaceDir);
      return entries.slice(0, MAX_LIST_ENTRIES);
    },

    async exec(
      command: string,
      execOpts?: { timeout?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const timeout =
        typeof execOpts?.timeout === "number" && execOpts.timeout > 0
          ? execOpts.timeout
          : DEFAULT_EXEC_TIMEOUT_MS;

      try {
        const { stdout, stderr } = await execAsync(String(command), {
          cwd: workspaceDir,
          timeout,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG,
            TERM: process.env.TERM,
            TMPDIR: process.env.TMPDIR,
            SHELL: process.env.SHELL,
          },
        });
        return {
          stdout: truncateString(stdout, MAX_OUTPUT_BYTES),
          stderr: truncateString(stderr, MAX_OUTPUT_BYTES),
          exitCode: 0,
        };
      } catch (err) {
        const execErr = err as {
          stdout?: string;
          stderr?: string;
          code?: number;
          signal?: string;
          message?: string;
        };
        return {
          stdout: truncateString(execErr.stdout ?? "", MAX_OUTPUT_BYTES),
          stderr: truncateString(execErr.stderr ?? execErr.message ?? "", MAX_OUTPUT_BYTES),
          exitCode: execErr.code ?? 1,
        };
      }
    },

    async fetch(
      url: string,
      fetchOpts?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<{ status: number; body: string; headers: Record<string, string> }> {
      if (!allowNetwork) {
        throw new Error("Network access is disabled in this sandbox configuration");
      }
      const headers =
        typeof fetchOpts?.headers === "object" && fetchOpts.headers !== null
          ? fetchOpts.headers
          : undefined;
      const body = typeof fetchOpts?.body === "string" ? fetchOpts.body : undefined;
      const method = typeof fetchOpts?.method === "string" ? fetchOpts.method : "GET";

      // Use SSRF-guarded fetch to prevent internal network access
      const { response, release } = await fetchWithSsrFGuard({
        url: String(url),
        init: { method, headers, body },
        timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      });

      try {
        const responseBody = await response.text();
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        return {
          status: response.status,
          body: truncateString(responseBody, MAX_OUTPUT_BYTES),
          headers: responseHeaders,
        };
      } finally {
        await release();
      }
    },

    log(...args: unknown[]): void {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logs.push(line);
    },
  };
}

// ---------------------------------------------------------------------------
// Cached builtins — static globals reused across invocations (P2-9)
// ---------------------------------------------------------------------------

const STATIC_BUILTINS = {
  JSON,
  Promise,
  Error,
  TypeError,
  RangeError,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Map,
  Set,
  WeakMap,
  WeakSet,
  RegExp,
  Date,
  Math,
  Symbol,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
};

// ---------------------------------------------------------------------------
// Sandbox execution
// ---------------------------------------------------------------------------

/**
 * Execute JavaScript code in a sandboxed vm context.
 *
 * The code has access to a global `api` object with file, exec, glob,
 * and (optionally) fetch methods.  It runs inside an async IIFE so
 * top-level `await` and `return` both work.
 *
 * NOTE: `vm.createContext` restricts the global scope but does NOT
 * provide OS-level isolation.  The code runs in the same process.
 * See the module-level doc comment for security considerations.
 */
export async function executeSandboxCode(
  code: string,
  opts: SandboxOptions,
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logs: string[] = [];
  const api = buildApiHandlers(opts, logs);

  // Track sandbox-created timers so we can cancel them all on completion.
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const sandboxSetTimeout = (fn: (...args: unknown[]) => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimers.delete(id);
      fn();
    }, ms);
    pendingTimers.add(id);
    return id;
  };
  const sandboxClearTimeout = (id: ReturnType<typeof setTimeout>) => {
    pendingTimers.delete(id);
    clearTimeout(id);
  };

  // Build a restricted vm context. Only expose the api, a safe console,
  // and standard language builtins — no require, process, or fs.
  // Static builtins are cached at module level; only api/console/timers vary per call.
  const context = vm.createContext({
    ...STATIC_BUILTINS,
    api,
    console: {
      log: api.log,
      warn: (...args: unknown[]) => api.log("[warn]", ...args),
      error: (...args: unknown[]) => api.log("[error]", ...args),
    },
    setTimeout: sandboxSetTimeout,
    clearTimeout: sandboxClearTimeout,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Wrap in an async IIFE so top-level await and return work
    const wrappedCode = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(wrappedCode, { filename: "execute_code.js" });

    // vm `timeout` handles synchronous infinite loops (e.g. `while(true){}`)
    // that would otherwise block the event loop forever. Promise.race below
    // covers async code that exceeds the time budget.
    const execution = script.runInContext(context, { timeout: timeoutMs });

    const result = await Promise.race([
      execution,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);

    return { success: true, result, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message, logs };
  } finally {
    clearTimeout(timer);
    // Cancel any timers left behind by sandbox code
    for (const id of pendingTimers) {
      clearTimeout(id);
    }
    pendingTimers.clear();
  }
}
