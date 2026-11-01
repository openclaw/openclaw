---
summary: "When deprecated plugin SDK surfaces become eligible for removal"
read_when:
  - You need the removal date or gate for an SDK subpath you import
  - You are planning migration work around a compatibility window
title: "Removal timeline"
sidebarTitle: "Removal timeline"
---

The dates and gates that govern when deprecated surfaces become removable. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

`pnpm plugin-sdk:surface:check` enforces the latest stable release's committed
typed public surface independently of export-count budgets. Removing a shipped
subpath or named export requires a covering `deprecated`, `removal-pending`, or
`removed` compatibility record with a `removeAfter` date strictly before the
current UTC date; a `removalGate` alone does not authorize removal. Packaged
private runtime facades without a `types` export condition are excluded because
they are not declared typed-public contracts.

## Removal timeline

| When                                                     | What happens                                                                                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Now**                                                  | Warning-capable deprecated surfaces emit runtime warnings; repository guards reject deprecated SDK imports from core and bundled plugins.                                                                             |
| **Pending owner decision**                               | Records without `removeAfter` or `removalGate` remain deprecated and ineligible until their owner publishes a gate.                                                                                                   |
| **Day after a `deprecated` record's `removeAfter` date** | At 00:00 UTC, that record becomes date-eligible and `pnpm plugins:boundary-report --fail-on-eligible-compat` exits non-zero. The date itself is the final compatibility day.                                          |
| **A `removal-pending` record's `removeAfter` date**      | At 00:00 UTC, the report marks the record due for review and lists its blockers. It does not trigger the compatibility fail flag.                                                                                     |
| **2026-12-31 — final SQLite compatibility day**          | Deprecated synchronous SQLite-backed members retain their released contracts through this date. Migrate to the documented async/V2 replacements before upgrading to the January removal release.                      |
| **First January 2027 stable release**                    | Remove the dated synchronous SQLite compatibility members after the next stable release ships the warnings and migration guide. No SDK major is required. The date gate first permits removal on January 1, 2027 UTC. |
| **Other ordinary stable release gates**                  | `inbound-reply-dispatch` and deprecated Mention Inbox signatures retain separate, undated `stable-deprecation-period` gates. Their owners must announce a window and authorize removal.                               |

The remaining public SDK surfaces below have registry-backed removal windows.
For synchronous SQLite-backed families, `removeAfter` is **2026-12-31** and
the removal target is the **first January 2027 stable release**. Deprecation
metadata written on main is not proof that a warning shipped in a stable
release. The next stable release must announce this window and publish the
warnings and migration instructions; the surface guard must still see a
reached date. This preparation adds deprecations and replacements without
removing public members. See the
[complete member migration table](/plugins/sdk-migration/sqlite-async),
[awaited migration instructions](/plugins/sdk-migration/how-to-migrate), and
[transcript and TTS replacements](/plugins/sdk-migration/async-transcript-and-tts).
The July 30 rows were removed after their early maintainer-authorized sweep:
unused subpaths were deleted, earlier compatibility aliases were deleted, and
bundled-only modules were demoted to private-local build mappings.

The August 15 compatibility subpaths `agent-config-primitives`,
`channel-logging`, `channel-secret-runtime`, `channel-streaming`,
`group-access`, `matrix`, `text-runtime`, and `zod` were retired early by
explicit SDK-owner approval in August 2026. Use the focused replacements in
the [Plugin SDK subpath catalog](/plugins/sdk-subpaths), and import `zod`
directly from the `zod` package. `inbound-reply-dispatch` remains available
until owner-authorized removal in a later stable release.

The beta.5 whole-session-store bridge was retired with explicit SDK-owner
approval on September 30, 2026, ahead of its former October 12 deadline.
The supported-plugin cutoff excludes `v2026.7.1-beta.5` and all releases that
still import those bridge exports or package-root whole-store aliases.
Upgrade affected plugins to scoped row and transcript-identity APIs before
upgrading the host. The `session-store-runtime` subpath and `resolveStorePath`
remain supported; see the [removed session APIs and replacements](/plugins/sdk-migration/removed-surfaces#removed-session-and-transcript-file-apis).

| Removal gate                            | Tier                                      | SDK subpaths                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-12-31`; first January 2027 stable | Final compatibility day / removal release | Synchronous SQLite-backed session/transcript, plugin-state, binding, auth/provider, channel/approval, workspace, proxy-capture, skill-discovery, runtime-config and TTS preparation APIs documented in the migration guide. |
| Later ordinary stable release — TBD     | Owner migration required                  | `inbound-reply-dispatch` and deprecated Mention Inbox signatures have separate undated windows.                                                                                                                             |
| `2026-10-01`                            | Media legacy projection                   | `agent-media-payload`, plus the non-subpath `MsgContext Media*` fields, channel inbound media payload builders, `buildMediaPayload`, hook media aliases, and `{{Media*}}` templates                                         |

The five compatibility subpaths `channel-lifecycle`, `channel-message`,
`channel-reply-pipeline`, `config-runtime`, and `infra-runtime` were retired
early by explicit SDK-owner approval on September 30, 2026. That decision
supersedes their October 1 gate and external-migration retention blocker; it
does not certify that every external plugin has migrated. Their public exports
and compatibility aliases are removed. Upgrade affected plugins before loading
them on a host containing this removal.

These subpaths remained available in 2026.8.2 under an approved retention
exception. On September 2, 2026, the release maintainer renewed their
`removeAfter` date from September 1 to October 1 for 2026.9.1. The September 30
decision replaces that window. See [channel import mappings](/plugins/sdk-migration/import-paths#retained-channel-facade-mappings)
and [config and infrastructure migration](/plugins/sdk-migration/how-to-migrate)
for replacements and behavioral differences. System-event snapshot inspection
and consumption now use `openclaw/plugin-sdk/system-event-runtime`.

The compatibility subpaths `command-auth`, `discord`, and `telegram-account`
were retired early by explicit SDK-owner approval on October 2, 2026. That
decision closes their compatibility window; it does not certify that every
external plugin has migrated. Their public exports are removed. Upgrade affected
plugins before loading them on a host containing this removal. See the
[command and channel facade replacements](/plugins/sdk-migration/import-paths#removed-command-and-channel-facades).

Bundled-plugin migration does not prove that every external caller can use a
path-only replacement. Migrate the functions with verified typed-public mappings;
adapt the caller where a removed named type or required behavior lacks a
public replacement. Do not substitute a private-local host export. Run
`pnpm plugins:boundary-report` to see the dates, gates, and blockers for the
surfaces your plugin uses.
