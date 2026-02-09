---
summary: "Steg-för-steg-checklista för release av npm + macOS-app"
read_when:
  - Skapa en ny npm-release
  - Skapa en ny macOS-app-release
  - Verifiera metadata före publicering
---

# Releasechecklista (npm + macOS)

Använd `pnpm` (Node 22+) från reporoten. Håll arbetsträdet rent innan taggning/publicering.

## Operatörstrigger

När operatören säger ”release”, gör omedelbart denna preflight (inga extra frågor om inget blockerar):

- Läs detta dokument och `docs/platforms/mac/release.md`.
- Ladda env från `~/.profile` och bekräfta att `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect-variabler är satta (SPARKLE_PRIVATE_KEY_FILE ska ligga i `~/.profile`).
- Använd Sparkle-nycklar från `~/Library/CloudStorage/Dropbox/Backup/Sparkle` vid behov.

1. **Version & metadata**

- [ ] Bump `package.json` version (t.ex., `2026.1.29`).
- [ ] Kör `pnpm plugins:sync` för att synka versioner + ändringsloggar för tilläggspaket.
- [ ] Uppdatera CLI-/versionssträngar: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) och Baileys user agent i [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Bekräfta paketmetadata (namn, beskrivning, repository, nyckelord, licens) och att `bin`-mappningen pekar på [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) för `openclaw`.
- [ ] Om beroenden ändrats, kör `pnpm install` så att `pnpm-lock.yaml` är uppdaterad.

2. **Build & artefakter**

- [ ] Om A2UI-indata ändrats, kör `pnpm canvas:a2ui:bundle` och committa eventuella uppdaterade [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (regenererar `dist/`).
- [ ] Verifiera att npm-paketet `files` inkluderar alla nödvändiga `dist/*`-mappar (särskilt `dist/node-host/**` och `dist/acp/**` för headless node + ACP CLI).
- [ ] Bekräfta att `dist/build-info.json` finns och innehåller förväntad `commit`-hash (CLI-bannern använder detta för npm-installationer).
- [ ] Valfritt: `npm pack --pack-destination /tmp` efter bygget; inspektera tarball-innehållet och behåll det redo för GitHub-releasen (committa det **inte**).

3. **Ändringslogg & dokumentation**

- [ ] Uppdatera `CHANGELOG.md` med användarsynliga höjdpunkter (skapa filen om den saknas); håll poster strikt fallande efter version.
- [ ] Säkerställ att README-exempel/flaggor matchar aktuell CLI-funktionalitet (särskilt nya kommandon eller alternativ).

4. **Validering**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (eller `pnpm test:coverage` om du behöver täckningsutdata)
- [ ] `pnpm release:check` (verifierar npm pack-innehåll)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker-installations-smoke test, snabb väg; krävs före release)
  - Om den omedelbart föregående npm-releasen är känd trasig, sätt `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` eller `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` för preinstall-steget.
- [ ] (Valfritt) Full installer-smoke (lägger till non-root + CLI-täckning): `pnpm test:install:smoke`
- [ ] (Valfritt) Installer E2E (Docker, kör `curl -fsSL https://openclaw.ai/install.sh | bash`, introducerar, kör sedan riktiga verktygsanrop):
  - `pnpm test:install:e2e:openai` (kräver `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (kräver `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (kräver båda nycklarna; kör båda leverantörerna)
- [ ] (Valfritt) Snabbkontrollera web gateway om dina ändringar påverkar sänd-/mottagningsvägar.

5. **macOS-app (Sparkle)**

- [ ] Bygg + signera macOS-appen och zip:a den för distribution.
- [ ] Generera Sparkle-appcast (HTML-noter via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) och uppdatera `appcast.xml`.
- [ ] Håll app-zippen (och valfri dSYM-zip) redo att bifogas GitHub-releasen.
- [ ] Följ [macOS release](/platforms/mac/release) för exakta kommandon och nödvändiga env-variabler.
  - `APP_BUILD` måste vara numerisk + monoton (inga `-beta`) så att Sparkle jämför versioner korrekt.
  - Vid notarization, använd `openclaw-notary`-nyckelringsprofilen som skapats från App Store Connect API-env-variabler (se [macOS release](/platforms/mac/release)).

6. **Publicera (npm)**

- [ ] Bekräfta att git-status är ren; committa och pusha vid behov.
- [ ] `npm login` (verifiera 2FA) vid behov.
- [ ] `npm publish --access public` (använd `--tag beta` för förhandsreleaser).
- [ ] Verifiera registret: `npm view openclaw version`, `npm view openclaw dist-tags` och `npx -y openclaw@X.Y.Z --version` (eller `--help`).

### Felsökning (anteckningar från 2.0.0-beta2-releasen)

- **npm pack/publicera hänger eller producerar enorma tarball**: macOS app bunt i `dist/OpenClaw.app` (och släpp zips) svepas in i paketet. Fixa genom att vitlista publicera innehåll via `package.json` `files` (inkludera dist underjord, dokument, färdigheter; exkludera apppaket). Bekräfta med `npm pack --dry-run` att `dist/OpenClaw.app` inte är listad.
- **npm auth web-loop för dist-tags**: använd legacy-auth för att få OTP-prompt:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx`-verifiering misslyckas med `ECOMPROMISED: Lock compromised`**: försök igen med en ny cache:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tagg behöver pekas om efter en sen fix**: tvångsuppdatera och pusha taggen, säkerställ sedan att GitHub-release-artefakter fortfarande matchar:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub-release + appcast**

- [ ] Tagga och pusha: `git tag vX.Y.Z && git push origin vX.Y.Z` (eller `git push --tags`).
- [ ] Skapa/uppdatera GitHub-releasen för `vX.Y.Z` med **titel `openclaw X.Y.Z`** (inte bara taggen); brödtexten ska inkludera den **fullständiga** ändringsloggssektionen för versionen (Höjdpunkter + Ändringar + Fixar), inline (inga bara länkar), och **får inte upprepa titeln i brödtexten**.
- [ ] Bifoga artefakter: `npm pack`-tarball (valfritt), `OpenClaw-X.Y.Z.zip` och `OpenClaw-X.Y.Z.dSYM.zip` (om genererad).
- [ ] Committa den uppdaterade `appcast.xml` och pusha den (Sparkle hämtar från main).
- [ ] Från en ren tempkatalog (inga `package.json`), kör `npx -y openclaw@X.Y.Z send --help` för att bekräfta att installation/CLI-entrypoints fungerar.
- [ ] Annonsera/dela release notes.

## Plugin-publiceringsomfång (npm)

Vi publicerar endast **befintliga npm plugins** under `@openclaw/*` -omfattningen. Paketerade
plugins som inte är på npm stannar **diskträd endast** (levereras fortfarande i
`extensions/**`).

Process för att ta fram listan:

1. `npm search @openclaw --json` och fånga paketnamnen.
2. Jämför med `extensions/*/package.json`-namn.
3. Publicera endast **snittmängden** (redan på npm).

Aktuell lista över npm-plugins (uppdatera vid behov):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

Release notes måste också lyfta **nya valfria bundlade plugins** som **inte är påslagna
som standard** (exempel: `tlon`).
