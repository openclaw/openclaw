import type { CodeModeWorkerPayload } from "./code-mode-worker-types.js";

export const codeModeNodeInitialization = Symbol("code-mode-node-initialization");
export type CodeModeNodeInitialization = { [codeModeNodeInitialization]?: SharedArrayBuffer };

type Catalog = Pick<
  Extract<CodeModeWorkerPayload<never>, { kind: "exec" }>,
  "catalog" | "namespaces" | "apiFiles" | "swarmEnabled"
>;

/** Core catalog snapshots own these bytes; public executor inputs remain mutable. */
export function prepareCodeModeNodeCatalog(input: Catalog) {
  const { catalog, namespaces, apiFiles, swarmEnabled } = input;
  const json = JSON.stringify({
    __openclawCatalog: catalog,
    __openclawNamespaces: namespaces,
    __openclawApiFiles: apiFiles ?? [],
    __openclawSwarmEnabled: swarmEnabled === true,
  });
  const buffer = new SharedArrayBuffer(Buffer.byteLength(json));
  new TextEncoder().encodeInto(json, new Uint8Array(buffer));
  return { catalog, namespaces, apiFiles, swarmEnabled, [codeModeNodeInitialization]: buffer };
}
