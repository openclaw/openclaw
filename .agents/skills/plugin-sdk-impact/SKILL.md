---
name: plugin-sdk-impact
description: Count Plugin SDK consumers across live ClawHub releases and bundled OpenClaw plugins before deprecation, removal, or behavior changes; supports public release-date filters.
---

# Plugin SDK impact

Combine current ClawHub inventories with a source scan of every bundled OpenClaw
plugin, including plugins absent from ClawHub, to inform compatibility decisions.
Static usage identifies dependencies; it does not prove execution or reliance on a
particular behavior. Keep the approval and deprecation rules in
[the SDK boundary guide](../../../src/plugin-sdk/AGENTS.md) authoritative.

## Investigate

1. Identify every affected public surface from source, including alternate SDK
   exports and runtime paths. Verify spelling against the definition and known
   callers; an incorrect key can return a convincing zero. Trace grouped facades,
   SDK helpers, and registration readers as well: a flat alias can have zero direct
   plugin calls while implementing a supported grouped method.
2. Scan every bundled plugin in a clean OpenClaw checkout using Plugin Inspector's
   static source analysis. Reuse an installed Inspector 0.4.3 or newer; otherwise
   install it in a separate temporary directory, without lifecycle scripts:

   ```sh
   inspector_dir=$(mktemp -d)
   npm install --prefix "$inspector_dir" --ignore-scripts @openclaw/plugin-inspector@0.4.3
   node {baseDir}/scripts/scan-bundled.mjs \
     --inspector "$inspector_dir/node_modules/@openclaw/plugin-inspector" \
     --out /tmp/openclaw-bundled-sdk-usage.json
   ```

   The scanner defaults to this skill's checkout; `--root <checkout>` selects
   another. It discovers `extensions/*/openclaw.plugin.json`, never executes
   plugin code, and records the commit, input fingerprint, Inspector version,
   every plugin, and incomplete analyses. A failed or timed-out scan remains a
   gap. Plugins without declared entrypoints also remain coverage gaps, because
   Inspector may miss implicit entrypoints. An interrupted corpus scan cannot be
   used as a finished inventory. Reuse the report for multiple queries while its
   source remains unchanged. A changed commit, plugin roster, or uncommitted source
   invalidates it; rescan instead of editing the receipt.

3. Query each canonical key with both sources:

   ```sh
   node {baseDir}/scripts/query.mjs 'api-member:api.registerTool' \
     --bundled /tmp/openclaw-bundled-sdk-usage.json
   ```

   For “updated within the last three months”, add `--months 3`. This means the
   latest eligible public release was uploaded within three calendar months of
   now, measured in UTC (month ends are clamped). Listing edits and rescans do not
   count as updates. The stored release date is its creation/upload time; public
   approval can happen later. `--since 2026-07-16T12:00:00Z` accepts an explicit cutoff.
   Report the exact inclusive cutoff from `releaseWindow`, not a guessed date.
   Public consumers and coverage use the same window on every page. Bundled
   source has no comparable upload date: report it separately, unfiltered, even
   for a recent-release question. The combined count is the union of that public
   release window and current bundled source, not a count of recent releases.

   The helper follows all usage and coverage pages, including empty intermediate
   pages. Counts and coverage include every result; `items`, `gaps`, and `warnings`
   contain bounded examples with omitted counts in `output.omitted`. Mixed
   references count in both runtime and type totals. For an investigation needing
   every consumer or gap, save `--full` output to a file and read it in sections:

   ```sh
   node {baseDir}/scripts/query.mjs 'api-member:api.registerTool' \
     --bundled /tmp/openclaw-bundled-sdk-usage.json --full > sdk-usage.json
   ```

   `--help` documents local endpoint and traversal limits.

4. Inspect matched evidence against the proposed change. A method call may not use
   the behavior being changed. Type-only consumers still matter for type/export
   removal. Query related members separately; a module import does not prove use
   of every export. Repeated references in a plugin count as one consumer.
5. For a usage-count question, report the key, query time, exact release window
   (if requested), ClawHub and bundled counts, their combined count, bundled commit,
   and both coverage gaps. Top-level `distinctPlugins` and `coverage` remain
   ClawHub-only; `bundled` describes source results; `combined` merges exact package
   identities once. Some bundled plugins have no package name: when they could
   overlap public matches, `combined.distinctPlugins` is null and
   `distinctPluginBounds` reports the possible range. `observedPluginIdentities`
   counts source identities before that uncertain overlap. Report the range,
   not its upper bound as an exact count. Different names remain distinct; never
   guess aliases from display names. Missing bundled evidence makes combined
   impact unavailable.
   For a proposed SDK change, also report matched evidence, indirect callers,
   and your compatibility recommendation. Finish change investigations with the maintainer's decision:
   preserve behavior, deprecate with migration, or proceed under existing policy.
   Never infer permission from the count.

## Canonical keys

| Surface             | Example                                                        |
| ------------------- | -------------------------------------------------------------- |
| SDK module          | `sdk-module:openclaw/plugin-sdk/core`                          |
| Named SDK export    | `sdk-export:openclaw/plugin-sdk/core#OpenClawPluginApi`        |
| Plugin API method   | `api-member:api.registerTool`                                  |
| Host runtime member | `runtime-member:runtime.channel.reply.dispatchReplyFromConfig` |
| Named hook          | `hook:hook.before_agent_start`                                 |
| Manifest contract   | `manifest-contract:manifest.contracts.tools:example_tool`      |

Keys describe SDK identities, not local aliases. `api.runtime` members normalize
to `runtime.*`. The inventory includes supported and deprecated references;
nonempty `deprecationCodes` selects entries associated with existing warnings.
Per-plugin inspection is available at
`https://clawhub.ai/api/v1/sdk-usage/plugin?package=<encoded-name>`; follow its
`nextCursor` until null to obtain the full inventory.

## Interpret the result

| Result                                                          | Report                                                                                                                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed consumers                                              | Report public, bundled, and combined counts with their separate scopes. Inspect evidence before judging a behavior change.                                                                           |
| No observed consumers, complete coverage                        | “No static references detected across N public/bundled plugin identities.” Requires both scans; excludes private non-bundled plugins and unbundled dependencies. Not proof that nobody uses the API. |
| Partial, failed, missing, incompatible, or unresolved analysis  | State observed matches, gap counts, and representative gaps. Zero matches leaves impact unknown.                                                                                                     |
| Empty corpus                                                    | No eligible plugins were observed; this provides no ecosystem assurance.                                                                                                                             |
| Unavailable endpoint, malformed result, or incomplete traversal | Impact is unknown. Preserve the error and use local evidence; never substitute zero.                                                                                                                 |

Coverage is tied to current release/artifact and analysis versions. Eligible
ClawHub reports have `inputKind: "artifact"`; bundled reports use `"source"`. A
source-checkout benchmark cannot establish what a published package contains. Source-only type references still matter for
SDK type and export removal; preserve the source of each match. An old scan
timestamp alone does not make an immutable artifact stale. Evidence is sampled;
each scan reports its evidence/unknown limits. Pages are live reads, not one
snapshot: rerun if releases or visibility change during the investigation. The
helper flags changes it observes but cannot establish a transaction-wide snapshot.

Do not dismiss a security issue just because no consumers were observed. Describe
how usage evidence affects compatibility risk; security and SDK owners still
decide the fix and any exception to the normal migration window.
