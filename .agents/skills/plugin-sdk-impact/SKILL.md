---
name: plugin-sdk-impact
description: Query how many public plugins use a Plugin SDK method, optionally by recent release date, and assess SDK deprecation or behavior changes using live ClawHub evidence.
---

# Plugin SDK impact

Use the current ClawHub inventory to inform the maintainer's compatibility decision.
Static usage identifies dependencies; it does not prove execution or reliance on a
particular behavior. Keep the approval and deprecation rules in
[the SDK boundary guide](../../../src/plugin-sdk/AGENTS.md) authoritative.

## Investigate

1. Identify every affected public surface from source, including alternate SDK
   exports and runtime paths. Verify spelling against the definition and known
   callers; an incorrect key can return a convincing zero. Search bundled callers
   locally as well: the registry only covers published public plugins.
2. Query each canonical key using the bundled helper:

   ```sh
   node {baseDir}/scripts/query.mjs 'api-member:api.registerTool'
   ```

   For “updated within the last three months”, add `--months 3`. This means the
   latest eligible public release was uploaded within three calendar months of
   now, measured in UTC (month ends are clamped). Listing edits and rescans do not
   count as updates. The stored release date is its creation/upload time; public
   approval can happen later. `--since 2026-07-16T12:00:00Z` accepts an explicit cutoff.
   Report the exact inclusive cutoff from `releaseWindow`, not a guessed date.
   Both consumers and coverage use the same window on every page.

   The helper follows all usage and coverage pages, including empty intermediate
   pages. Counts and coverage include every result; `items`, `gaps`, and `warnings`
   contain bounded examples with omitted counts in `output.omitted`. Mixed
   references count in both runtime and type totals. For an investigation needing
   every consumer or gap, save `--full` output to a file and read it in sections:

   ```sh
   node {baseDir}/scripts/query.mjs 'api-member:api.registerTool' --full > sdk-usage.json
   ```

   `--help` documents local endpoint and traversal limits.

3. Inspect matched evidence against the proposed change. A method call may not use
   the behavior being changed. Type-only consumers still matter for type/export
   removal. Query related members separately; a module import does not prove use
   of every export. Repeated references in a plugin count as one consumer.
4. For a usage-count question, report the key, query time, exact release window
   (if requested), distinct plugins, and coverage gaps. For a proposed SDK change,
   also report matched evidence, local callers, and your compatibility
   recommendation. Finish change investigations with the maintainer's decision:
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

| Result                                                          | Report                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Observed consumers                                              | “N current public plugins reference this surface.” Inspect their evidence before judging a behavior change.                                                                                |
| No observed consumers, complete coverage                        | “No static references detected across N eligible public plugin artifacts.” This excludes private/unpublished plugins and unbundled dependencies; it is not proof that nobody uses the API. |
| Partial, failed, missing, incompatible, or unresolved analysis  | State observed matches, gap counts, and representative gaps. Zero matches leaves impact unknown.                                                                                           |
| Empty corpus                                                    | No eligible plugins were observed; this provides no ecosystem assurance.                                                                                                                   |
| Unavailable endpoint, malformed result, or incomplete traversal | Impact is unknown. Preserve the error and use local evidence; never substitute zero.                                                                                                       |

Coverage is tied to current release/artifact and analysis versions. Eligible
reports have `inputKind: "artifact"`; a source-checkout benchmark cannot establish
what a published package contains. An old scan
timestamp alone does not make an immutable artifact stale. Evidence is sampled;
each scan reports its evidence/unknown limits. Pages are live reads, not one
snapshot: rerun if releases or visibility change during the investigation. The
helper flags changes it observes but cannot establish a transaction-wide snapshot.

Do not dismiss a security issue just because no consumers were observed. Describe
how usage evidence affects compatibility risk; security and SDK owners still
decide the fix and any exception to the normal migration window.
