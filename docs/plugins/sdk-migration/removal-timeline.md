---
summary: "When deprecated plugin SDK surfaces become eligible for removal"
read_when:
  - You need the removal date or gate for an SDK subpath you import
  - You are planning migration work around a compatibility window
title: "Removal timeline"
sidebarTitle: "Removal timeline"
---

The dates and gates that govern when deprecated surfaces become removable. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Removal timeline

| When                                                     | What happens                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Now**                                                  | Warning-capable deprecated surfaces emit runtime warnings; repository guards reject deprecated SDK imports from core and bundled plugins.                                    |
| **Pending owner decision**                               | Records without `removeAfter` or `removalGate` remain deprecated and ineligible until their owner publishes a gate.                                                          |
| **Day after a `deprecated` record's `removeAfter` date** | At 00:00 UTC, that record becomes date-eligible and `pnpm plugins:boundary-report --fail-on-eligible-compat` exits non-zero. The date itself is the final compatibility day. |
| **A `removal-pending` record's `removeAfter` date**      | At 00:00 UTC, the report marks the record due for review and lists its blockers. It does not trigger the compatibility fail flag.                                            |
| **Next Plugin SDK major**                                | `inbound-reply-dispatch` reaches its explicit `next-plugin-sdk-major` gate; it is not date-eligible before that version boundary.                                            |

The remaining public SDK subpaths below have registry-backed removal windows.
The July 30 rows were removed after their early maintainer-authorized sweep:
unused subpaths were deleted, earlier compatibility aliases were deleted, and
bundled-only modules were demoted to private-local build mappings.

The August 15 compatibility subpaths `agent-config-primitives`,
`channel-logging`, `channel-secret-runtime`, `channel-streaming`,
`group-access`, `matrix`, `text-runtime`, and `zod` were retired early by
explicit SDK-owner approval in August 2026. Use the focused replacements in
the [Plugin SDK subpath catalog](/plugins/sdk-subpaths), and import `zod`
directly from the `zod` package. `inbound-reply-dispatch` remains available
until the next Plugin SDK major.

| Removal gate            | Tier                               | SDK subpaths                                                                                                                                                                        |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-10-01`            | Earlier compatibility deprecations | `channel-lifecycle`, `channel-message`, `channel-reply-pipeline`, `config-runtime`, `infra-runtime`                                                                                 |
| `next-plugin-sdk-major` | Major-version compatibility gate   | `inbound-reply-dispatch`                                                                                                                                                            |
| `2026-10-01`            | Media legacy projection            | `agent-media-payload`, plus the non-subpath `MsgContext Media*` fields, channel inbound media payload builders, `buildMediaPayload`, hook media aliases, and `{{Media*}}` templates |

The five September 1 subpaths remain available in 2026.8.2 under an approved
retention exception; that release’s registry still labels them `deprecated`.
For 2026.9.1, the release maintainer approved renewing their `removeAfter` date
from `2026-09-01` to `2026-10-01` on September 2, 2026. The registry keeps them
`removal-pending` with the same replacement mappings. Removal awaits verification
that supported external plugins have migrated. `infra-runtime` additionally retains
system-event snapshot inspection and consumption until a modern public replacement
exists. This changes compatibility tracking only, not the exported SDK or runtime
behavior.

Bundled-plugin migration does not prove that every external caller can use a
path-only replacement. Migrate the functions with verified typed-public mappings;
keep retained imports where a named type or required behavior still lacks a
public replacement and ask the SDK owner to resolve that gap. Run
`pnpm plugins:boundary-report` to see the dates, gates, and blockers for the
surfaces your plugin uses.
