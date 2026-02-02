# Coding Style & Conventions

## Language
- TypeScript (ESM)
- Prefer strict typing; avoid `any`

## Formatting
- Oxlint and Oxfmt
- Run `pnpm lint` before commits
- Add brief code comments for tricky/non-obvious logic

## File Size
- Aim for <700 LOC (guideline, not hard guardrail)
- Split/refactor when it improves clarity or testability
- Keep files concise; extract helpers instead of "V2" copies

## Naming
- **DNA** — Product/app/docs headings
- **dna** — CLI command, package/binary, paths, config keys

## Patterns
- Use existing patterns for CLI options
- Use `createDefaultDeps` for dependency injection
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner)
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`)
- Colors: use shared CLI palette in `src/terminal/palette.ts` (no hardcoded colors)

## Release Channels
| Channel | Tag Format | npm dist-tag |
|---------|------------|--------------|
| stable | `vYYYY.M.D` | `latest` |
| beta | `vYYYY.M.D-beta.N` | `beta` |
| dev | No tag (main branch) | — |

## Tool Schema Guardrails
- Avoid `Type.Union` in tool input schemas (no `anyOf`/`oneOf`/`allOf`)
- Use `stringEnum`/`optionalStringEnum` for string lists
- Use `Type.Optional(...)` instead of `... | null`
- Keep top-level tool schema as `type: "object"` with `properties`
- Avoid raw `format` property names (reserved keyword)

## Dependencies
- Never edit `node_modules`
- Never update the Carbon dependency
- Patched dependencies (`pnpm.patchedDependencies`) must use exact version (no `^`/`~`)
- Patching requires explicit approval
