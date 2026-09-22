import { createHash, type Hash } from "node:crypto";
import { serialize } from "node:v8";
import type { CodeModeCatalogProjection } from "./code-mode-catalog.js";
import type { CodeModeApiVirtualFile, CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { createCodeModeToolApiFile } from "./code-mode-tool-api.js";
import { ToolInputError } from "./tool-input-error.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchCatalogSession } from "./tool-search-types.js";

const GLOBALS = `
declare function text(value: unknown): void;
declare function json(value: unknown): void;
declare function yield_control(reason?: string): Promise<void>;
declare function setTimeout<T extends unknown[]>(callback: (...args: T) => void, delay?: number, ...args: T): number;
declare function clearTimeout(id: number): void;
declare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void; debug(...values: unknown[]): void };
declare class TextEncoder { readonly encoding: string; encode(input?: string): Uint8Array; encodeInto(input: string, destination: Uint8Array): { read: number; written: number }; }
declare class TextDecoder { constructor(label?: string, options?: {fatal?: boolean; ignoreBOM?: boolean}); decode(input?: ArrayBuffer | ArrayBufferView, options?: {stream?: boolean}): string; readonly encoding: string; readonly fatal: boolean; readonly ignoreBOM: boolean; }
type CodeModeHandle = ((input?: unknown) => Promise<unknown>) & { callableName: string; toolName: string; description: string; describe(): Promise<unknown> } & ({source: "mcp"; apiPath: string} | {source: "openclaw" | "client"; apiPath?: undefined});
declare const catalog: { search(query: string, options?: {limit?: number}): Promise<readonly CodeModeHandle[]>; all(): readonly CodeModeHandle[] };
type CodeModeApiFile = {path: string; description?: string; bytes: number; content: string};
declare const API: { list(prefix?: string): Promise<{files: Array<{path: string; description?: string; bytes?: number}>}>; read(path: string): Promise<CodeModeApiFile> };
declare const skills: { list(): Promise<unknown>; read(name: string): Promise<string> };
declare const nodes: {
  list(): Promise<Array<{ id: string; name: string; platform?: string; connected: boolean; commands: string[] }>>;
  get(idOrName: string): Promise<{
    readonly id: string;
    readonly name: string;
    readonly invoke: (command: string, params?: unknown) => Promise<unknown>;
    readonly listDir?: (path: string) => Promise<unknown>;
  }>;
};
declare const namespaces: unknown;
`;

// Only the current declaration text is retained; schemas and executable tools stay
// with the catalog owner. A changed contract replaces this single bounded entry.
const declarationsByCatalog = new WeakMap<
  ToolSearchCatalogSession,
  { fingerprint: string; content: string; bytes: number }
>();

/** Opt-in only: use the same effective owner declarations as API.read. */
export async function createPreflightDeclarations(
  runtime: ToolSearchRuntime,
  projection: CodeModeCatalogProjection,
  apiFiles: CodeModeApiVirtualFile[],
  namespaces: CodeModeNamespaceRuntime,
  maxBytes: number,
  catalog: ToolSearchCatalogSession,
): Promise<string> {
  let fingerprint: Hash | undefined = createHash("sha256");
  const contracts = [];
  for (const binding of projection.bindings) {
    const entry = await runtime.describe(binding.id, { includeMcp: false });
    // Client schemas remain opaque, including lazy objects that cannot be walked.
    if (fingerprint) {
      try {
        // Binary serialization preserves cycles and values that JSON conflates,
        // without invoking toJSON hooks. Uncloneable metadata bypasses reuse.
        fingerprint.update(
          serialize([
            binding.callableName,
            entry.source,
            entry.source === "openclaw" ? entry.parameters : undefined,
            entry.source === "openclaw" ? entry.outputSchema : undefined,
          ]),
        );
      } catch {
        fingerprint = undefined;
      }
    }
    contracts.push({ callableName: binding.callableName, entry });
  }
  for (const file of apiFiles) {
    fingerprint?.update(JSON.stringify(file.content));
  }
  fingerprint?.update(JSON.stringify(namespaces.descriptors.map(({ globalName }) => globalName)));
  const key = fingerprint?.digest("hex");
  const cached = key ? declarationsByCatalog.get(catalog) : undefined;
  if (cached && cached.fingerprint === key && cached.bytes <= maxBytes) {
    return cached.content;
  }
  // Do not retain declarations from a previous, possibly wider catalog if the
  // replacement fails its allowance or contract preparation.
  declarationsByCatalog.delete(catalog);
  const parts: string[] = [];
  let bytes = 0;
  const add = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8") + 1;
    if (bytes > maxBytes) {
      throw new ToolInputError(
        "TypeScript preflight declarations exceed the existing memory allowance; narrow the catalog.",
      );
    }
    parts.push(text);
  };
  add(GLOBALS);
  for (const { callableName, entry } of contracts) {
    add((await createCodeModeToolApiFile(callableName, entry)).content);
  }
  for (const file of apiFiles) {
    add(file.content);
  }
  for (const descriptor of namespaces.descriptors) {
    if (descriptor.globalName !== "MCP") {
      add("declare const " + descriptor.globalName + ": unknown;");
    }
  }
  const content = parts.join("\n");
  if (key) {
    declarationsByCatalog.set(catalog, { fingerprint: key, content, bytes });
  }
  return content;
}
