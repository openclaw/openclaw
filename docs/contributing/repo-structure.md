# Repository Structure

## Source Code
- `src/` — Main source
  - `src/cli` — CLI wiring
  - `src/commands` — Commands
  - `src/provider-web.ts` — Web provider
  - `src/infra` — Infrastructure
  - `src/media` — Media pipeline
- `dist/` — Built output

## Tests
- Colocated `*.test.ts` files
- E2E tests: `*.e2e.test.ts`

## Docs
- `docs/` — Documentation (images, queue, Pi config)
- Hosted on Mintlify (docs.molt.bot)

## Plugins/Extensions
- Live under `extensions/*` (workspace packages)
- Keep plugin-only deps in extension `package.json`
- Don't add to root `package.json` unless core uses them
- Install runs `npm install --omit=dev` in plugin dir
- Runtime deps must be in `dependencies`
- Avoid `workspace:*` in `dependencies` (npm install breaks)
- Put `dna` in `devDependencies` or `peerDependencies`

## Installers
- Served from `https://molt.bot/*`
- Live in sibling repo `../molt.bot`
  - `public/install.sh`
  - `public/install-cli.sh`
  - `public/install.ps1`

## Messaging Channels

Consider **all** channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).

**Core channels:**
- Docs: `docs/channels/`
- Code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web`, `src/channels`, `src/routing`

**Extensions:**
- `extensions/*` (msteams, matrix, zalo, zalouser, voice-call, etc.)

When adding channels/extensions/apps/docs, review `.github/labeler.yml` for label coverage.
