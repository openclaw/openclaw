import { isJsonObject, type CodexDynamicToolSpec } from "./protocol.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { parseCodexToolDeclarations } from "./tool-declarations.js";

type CatalogBinding = {
  connectionScope?: "supervision";
  dynamicToolsFingerprint?: string;
  managedToolCatalog?: unknown;
};

function invalidCatalog() {
  return new Error(
    "The saved Codex thread tool catalog is missing, corrupt, or changed; the thread is preserved. Inspect its native metadata or reconnect before retrying.",
  );
}

function matchesCatalog(fingerprint: string | undefined, tools: CodexDynamicToolSpec[]) {
  return (
    fingerprint !== undefined &&
    areCodexDynamicToolFingerprintsCompatible({
      previous: fingerprint,
      next: codexDynamicToolsFingerprint(tools),
      nextLegacy: codexLegacyDynamicToolsFingerprint(tools),
    })
  );
}

/** Accepted declarations are data; neither legacy policy hashes nor this receipt grant execution. */
export function readCodexThreadToolCatalog(
  binding: CatalogBinding | undefined,
): CodexDynamicToolSpec[] | undefined {
  if (
    !binding ||
    binding.connectionScope === "supervision" ||
    binding.managedToolCatalog === undefined
  ) {
    return undefined;
  }
  const receipt = binding.managedToolCatalog;
  if (
    !isJsonObject(receipt) ||
    (receipt.version !== 1 && receipt.version !== 2 && receipt.version !== 3)
  ) {
    throw invalidCatalog();
  }
  const tools = parseCodexToolDeclarations(receipt.tools, invalidCatalog);
  if (!matchesCatalog(binding.dynamicToolsFingerprint, tools)) {
    throw invalidCatalog();
  }
  return tools;
}

/** Called only after native acceptance or verified reuse of the matching immutable catalog. */
export function buildCodexThreadToolCatalogPatch(
  binding: CatalogBinding | undefined,
  tools: CodexDynamicToolSpec[],
  acceptedFingerprint: string,
): { managedToolCatalog?: { version: 3; tools: CodexDynamicToolSpec[] } } {
  if (
    binding?.connectionScope === "supervision" ||
    binding?.managedToolCatalog !== undefined ||
    (binding !== undefined && binding.dynamicToolsFingerprint === undefined)
  ) {
    return {};
  }
  if (
    binding?.dynamicToolsFingerprint !== undefined &&
    binding.dynamicToolsFingerprint !== acceptedFingerprint &&
    binding.dynamicToolsFingerprint !== codexLegacyDynamicToolsFingerprint(tools)
  ) {
    throw invalidCatalog();
  }
  return {
    managedToolCatalog: {
      version: 3,
      tools,
    },
  };
}
