# Coding Conventions

## Language & Types

- TypeScript (ESM). Prefer strict typing; avoid `any`.
- Never add `@ts-nocheck` and do not disable `no-explicit-any`; fix root causes.
- Never share class behavior via prototype mutation (`applyPrototypeMixins`, `Object.defineProperty` on `.prototype`). Use explicit inheritance/composition.
- In tests, prefer per-instance stubs over prototype mutation unless explicitly documented.

## Formatting & Linting

- Oxlint + Oxfmt. Run `pnpm check` before commits.
- Format fix: `pnpm format:fix`

## Naming

- Use **OpenClaw** for product/app/docs headings; use `openclaw` for CLI command, package/binary, paths, config keys.
- Add brief code comments for tricky or non-obvious logic.

## File Size

- Aim to keep files under ~700 LOC (guideline, not hard guardrail). Split/refactor when it improves clarity or testability.

## Dependency Management

- Any dep with `pnpm.patchedDependencies` must use exact version (no `^`/`~`).
- Patching dependencies requires explicit approval; do not do this by default.
- Never update the Carbon dependency.

## Tool Schema (google-antigravity guardrails)

- Avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`.
- Use `stringEnum`/`optionalStringEnum` for string lists, `Type.Optional(...)` instead of `... | null`.
- Avoid raw `format` property names in tool schemas.

## Plugin/Extension Structure

- Plugin-only deps stay in the extension `package.json`; do not add to root `package.json` unless core uses them.
- Runtime deps must live in `dependencies` (not `devDependencies`). Avoid `workspace:*` in `dependencies`.
- Put `openclaw` in `devDependencies` or `peerDependencies` (runtime resolves `openclaw/plugin-sdk` via jiti alias).

## GitHub Footguns

- Never use `gh issue/pr comment -b "..."` when body contains backticks or shell chars. Use single-quoted heredoc (`-F - <<'EOF'`).
- Don't wrap issue/PR refs like `#24643` in backticks when you want auto-linking. Use plain `#24643`.
