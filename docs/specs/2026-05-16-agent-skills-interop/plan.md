# Plan — Agent Skills format interop

## Approach

Add a small loader layer that parses SKILL.md frontmatter in either the canonical Anthropic shape or the current openclaw shape, normalizes into one internal representation, and feeds existing discovery. Add CLI import/export commands that translate to/from the Anthropic file layout. Keep `metadata.openclaw` as the home for install hints; document the conventions in `docs/tools/skills.md`.

## Steps

1. Define an internal `SkillManifest` TypeBox schema in `src/plugins/skill-manifest.ts` that holds the normalized fields (`name`, `description`, `metadata.openclaw.*`, optional `allowed_tools`).
2. Parse the SKILL.md frontmatter into `SkillManifest` accepting both shapes. Reject ambiguous mixes with a typed error.
3. Update `src/plugins/discovery.ts` to use the new manifest type; keep behavior for installed-bin checks identical.
4. Feed `allowed_tools` (when present) into `src/agents/tool-policy.ts` so the skill ships with its own tool allowlist.
5. Add `openclaw skills import <path|url>` — fetch + extract + validate; refuses bundles with executable scripts unless `--allow-scripts` is passed.
6. Add `openclaw skills export <name>` — emit a tarball matching the canonical file layout for use in Claude.ai / Claude Code / Agent SDK.
7. `openclaw doctor` — surface old-shape skills with a migration hint (no auto-rewrite).
8. Docs: extend `docs/tools/skills.md` with the canonical shape, the `metadata.openclaw` extension, and a migration recipe.

## Dependencies / order

- Steps 1–2 (schema + parser) block everything else.
- Step 4 (allowed-tools wiring) depends on 3.
- Steps 5–6 (import/export) can land in parallel with each other after 1–3.
