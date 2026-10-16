---
name: plugin-sdk-impact
description: Assess plugin consumers before SDK deprecation, removal, or incompatible behavior/security changes using public ClawHub usage evidence.
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
2. Query each canonical key from the repository root:

   ```sh
   node .agents/skills/plugin-sdk-impact/scripts/query.mjs 'api-member:api.registerTool'
   ```

   The helper follows all usage and coverage pages, including empty intermediate
   pages. It prints distinct plugin counts, runtime/type counts, bounded evidence,
   release/scan identities, and coverage gaps. Mixed references count in both
   runtime and type totals. `--help` documents local endpoint and traversal limits.

3. Inspect matched evidence against the proposed change. A method call may not use
   the behavior being changed. Type-only consumers still matter for type/export
   removal. Query related members separately; a module import does not prove use
   of every export. Repeated references in a plugin count as one consumer.
4. Report the keys, query time, consumers and evidence, coverage gaps, local caller
   findings, and your compatibility recommendation. Finish with the maintainer's
   decision to make: preserve behavior, deprecate with migration, or proceed under
   the existing policy. Never infer permission from the count.

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
| Partial, failed, missing, incompatible, or unresolved analysis  | State observed matches and list the gaps. Zero matches leaves impact unknown.                                                                                                              |
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
