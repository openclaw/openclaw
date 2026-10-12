/**
 * Shared scan behind every coverage guard over
 * `listAppServerRuntimeModelBackendBindings()`.
 *
 * Two guards assert over the same bundled-manifest scan: the unit guard in
 * `app-server-runtime-bindings.test.ts` and scenario 5 of
 * `scripts/proof-app-server-runtime-chooser-bindings.ts`. They previously each
 * carried a copy, and the copies drifted — the proof's lacked the
 * dynamic-applicability exclusion, so it demanded a fixed binding row for every
 * ACPX bridge and could never pass. The scan lives here once instead.
 *
 * This is guard support rather than production code: nothing on a request path
 * reads it, and it deliberately keeps `bundled-plugin-metadata`'s on-disk
 * manifest scan out of the modules that answer runtime compatibility.
 */
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";

/**
 * Bundled plugins whose harnesses declare provider applicability DYNAMICALLY per
 * model route instead of naming a canonical provider id, so they intentionally
 * have no binding row. `acpx`'s native ACP bridges (OpenCode, Qwen Code, Pi,
 * Kilo Code, Copilot-via-ACP) opt into whichever configured model route lists
 * them in `runtimePolicy.compatibleIds`; `createModelCatalogDecisions()`
 * discovers them from that route data and confirms them with
 * `harness.supports()`. A dedicated single-provider harness (`codex`, `copilot`)
 * still needs a row.
 */
const DYNAMIC_PROVIDER_DISCOVERY_PLUGIN_IDS: ReadonlySet<string> = new Set(["acpx"]);

type BundledAppServerHarnessIds = {
  /** Harnesses that must appear in the binding table. */
  fixed: readonly string[];
  /** Harnesses that must NOT appear in it, because their routes are dynamic. */
  dynamic: readonly string[];
};

/**
 * Splits the agent harnesses declared by bundled manifests into the ones the
 * binding table owns and the ones it deliberately does not.
 *
 * CLI backends are excluded from both: they declare `modelProvider` on their own
 * registration and are covered by `listCliRuntimeModelBackendBindings()`.
 */
export function listBundledAppServerHarnessIds(): BundledAppServerHarnessIds {
  const fixed = new Set<string>();
  const dynamic = new Set<string>();
  for (const entry of listBundledPluginMetadata({ includeChannelConfigs: false })) {
    const cliBackends = new Set(entry.manifest.cliBackends ?? []);
    const target = DYNAMIC_PROVIDER_DISCOVERY_PLUGIN_IDS.has(entry.manifest.id) ? dynamic : fixed;
    for (const harnessId of entry.manifest.activation?.onAgentHarnesses ?? []) {
      if (!cliBackends.has(harnessId)) {
        target.add(harnessId);
      }
    }
  }
  const sorted = (ids: Set<string>) =>
    [...ids].toSorted((left, right) => left.localeCompare(right));
  return { fixed: sorted(fixed), dynamic: sorted(dynamic) };
}
