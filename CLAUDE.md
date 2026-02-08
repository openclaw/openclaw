# Fork-Specific Notes (alex-jadecli/openclaw)

This is a personal fork. Never create PRs against the upstream `openclaw/openclaw` repository.
All PRs should target this fork's `main` branch (`alex-jadecli/openclaw`).

---

# Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".

## Project Structure & Module Organization

- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.
- Plugins: install runs `npm install --omit=dev` in plugin dir; runtime deps must live in `dependencies`. Avoid `workspace:*` in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies` instead (runtime resolves `openclaw/plugin-sdk` via jiti alias).
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).

## Build, Test, and Development Commands

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- Build: `pnpm build`
- Dev (auto-reload): `pnpm gateway:watch`
- Type-check: `pnpm tsgo`
- Lint/format: `pnpm check` (tsgo + lint + format)
- Lint: `pnpm lint` (oxlint with type-awareness)
- Lint fix: `pnpm lint:fix`
- Format check: `pnpm format` (oxfmt)
- Format fix: `pnpm format:fix`
- Tests: `pnpm test` (vitest); single file: `npx vitest run path/to/file.test.ts`
- Coverage: `pnpm test:coverage`
- E2E: `pnpm test:e2e`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM, ES2023). Prefer strict typing; avoid `any`.
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.
- Keep files under ~500 LOC when feasible.
- Use oxlint/oxfmt conventions (no Prettier/ESLint).
