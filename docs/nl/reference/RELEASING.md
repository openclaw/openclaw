---
summary: "Stapsgewijze release-checklist voor npm + macOS-app"
read_when:
  - Een nieuwe npm-release maken
  - Een nieuwe macOS-apprelease maken
  - Metadata verifiëren vóór publicatie
---

# Release-checklist (npm + macOS)

Gebruik `pnpm` (Node 22+) vanaf de root van de repo. Houd de working tree schoon vóór taggen/publiceren.

## Operator-trigger

Wanneer de operator “release” zegt, voer onmiddellijk deze preflight uit (geen extra vragen tenzij geblokkeerd):

- Lees dit document en `docs/platforms/mac/release.md`.
- Laad omgevingsvariabelen vanuit `~/.profile` en bevestig dat `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect-variabelen zijn ingesteld (SPARKLE_PRIVATE_KEY_FILE moet zich bevinden in `~/.profile`).
- Gebruik Sparkle-sleutels uit `~/Library/CloudStorage/Dropbox/Backup/Sparkle` indien nodig.

1. **Versie & metadata**

- [ ] Verhoog de `package.json`-versie (bijv. `2026.1.29`).
- [ ] Voer `pnpm plugins:sync` uit om extensiepakketversies + changelogs uit te lijnen.
- [ ] Werk CLI/versiestrings bij: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) en de Baileys user agent in [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Bevestig pakketmetadata (naam, beschrijving, repository, trefwoorden, licentie) en dat de `bin`-map verwijst naar [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) voor `openclaw`.
- [ ] Als afhankelijkheden zijn gewijzigd, voer `pnpm install` uit zodat `pnpm-lock.yaml` actueel is.

2. **Build & artefacten**

- [ ] Als A2UI-invoer is gewijzigd, voer `pnpm canvas:a2ui:bundle` uit en commit eventuele bijgewerkte [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (genereert `dist/` opnieuw).
- [ ] Verifieer dat het npm-pakket `files` alle vereiste `dist/*`-mappen bevat (met name `dist/node-host/**` en `dist/acp/**` voor headless node + ACP CLI).
- [ ] Bevestig dat `dist/build-info.json` bestaat en de verwachte `commit`-hash bevat (de CLI-banner gebruikt dit voor npm-installaties).
- [ ] Optioneel: `npm pack --pack-destination /tmp` na de build; inspecteer de tarball-inhoud en houd deze bij de hand voor de GitHub-release (commit deze **niet**).

3. **Changelog & documentatie**

- [ ] Werk `CHANGELOG.md` bij met gebruikersgerichte hoogtepunten (maak het bestand aan als het ontbreekt); houd items strikt aflopend per versie.
- [ ] Zorg dat README-voorbeelden/flags overeenkomen met het huidige CLI-gedrag (met name nieuwe opdrachten of opties).

4. **Validatie**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (of `pnpm test:coverage` als je dekkingsuitvoer nodig hebt)
- [ ] `pnpm release:check` (verifieert npm pack-inhoud)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker-installatie smoke test, snelle route; vereist vóór release)
  - Als de direct vorige npm-release bekend defect is, stel `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` of `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` in voor de preinstall-stap.
- [ ] (Optioneel) Volledige installer smoke (voegt non-root + CLI-dekking toe): `pnpm test:install:smoke`
- [ ] (Optioneel) Installer E2E (Docker, voert `curl -fsSL https://openclaw.ai/install.sh | bash` uit, onboardt en voert vervolgens echte tool-aanroepen uit):
  - `pnpm test:install:e2e:openai` (vereist `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (vereist `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (vereist beide sleutels; voert beide providers uit)
- [ ] (Optioneel) Spot-check de web gateway als je wijzigingen de verzend/ontvang-paden beïnvloeden.

5. **macOS-app (Sparkle)**

- [ ] Build en onderteken de macOS-app en zip deze vervolgens voor distributie.
- [ ] Genereer de Sparkle-appcast (HTML-notities via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) en werk `appcast.xml` bij.
- [ ] Houd de app-zip (en optionele dSYM-zip) gereed om aan de GitHub-release te koppelen.
- [ ] Volg [macOS release](/platforms/mac/release) voor de exacte opdrachten en vereiste omgevingsvariabelen.
  - `APP_BUILD` moet numeriek en monotoon zijn (geen `-beta`) zodat Sparkle versies correct vergelijkt.
  - Als je notariseert, gebruik het `openclaw-notary`-sleutelhangprofiel dat is aangemaakt op basis van App Store Connect API-omgevingsvariabelen (zie [macOS release](/platforms/mac/release)).

6. **Publiceren (npm)**

- [ ] Bevestig dat git status schoon is; commit en push indien nodig.
- [ ] `npm login` (verifieer 2FA) indien nodig.
- [ ] `npm publish --access public` (gebruik `--tag beta` voor pre-releases).
- [ ] Verifieer de registry: `npm view openclaw version`, `npm view openclaw dist-tags` en `npx -y openclaw@X.Y.Z --version` (of `--help`).

### Problemen oplossen (notities uit de 2.0.0-beta2-release)

- **npm pack/publish hangt of produceert een enorme tarball**: de macOS-appbundle in `dist/OpenClaw.app` (en release-zips) worden in het pakket meegenomen. Los dit op door publicatie-inhoud te whitelisten via `package.json` `files` (inclusief dist-submappen, docs, skills; exclusief appbundles). Bevestig met `npm pack --dry-run` dat `dist/OpenClaw.app` niet wordt vermeld.
- **npm auth web-loop voor dist-tags**: gebruik legacy-auth om een OTP-prompt te krijgen:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx`-verificatie faalt met `ECOMPROMISED: Lock compromised`**: probeer opnieuw met een frisse cache:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tag moet opnieuw worden gepoint na een late fix**: force-update en push de tag en zorg er daarna voor dat de GitHub-release-assets nog steeds overeenkomen:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub-release + appcast**

- [ ] Tag en push: `git tag vX.Y.Z && git push origin vX.Y.Z` (of `git push --tags`).
- [ ] Maak/ververs de GitHub-release voor `vX.Y.Z` met **titel `openclaw X.Y.Z`** (niet alleen de tag); de body moet de **volledige** changelogsectie voor die versie bevatten (Highlights + Changes + Fixes), inline (geen kale links), en **mag de titel niet herhalen in de body**.
- [ ] Voeg artefacten toe: `npm pack`-tarball (optioneel), `OpenClaw-X.Y.Z.zip` en `OpenClaw-X.Y.Z.dSYM.zip` (indien gegenereerd).
- [ ] Commit de bijgewerkte `appcast.xml` en push deze (Sparkle leest feeds vanaf main).
- [ ] Voer vanuit een schone tijdelijke map (geen `package.json`) `npx -y openclaw@X.Y.Z send --help` uit om te bevestigen dat installatie/CLI-entrypoints werken.
- [ ] Kondig de release aan/deel de releasenotes.

## Plugin-publicatiescope (npm)

We publiceren alleen **bestaande npm-plugins** onder de `@openclaw/*`-scope. Gebundelde
plugins die niet op npm staan blijven **alleen in de schijfboom** (worden nog steeds meegeleverd in
`extensions/**`).

Proces om de lijst af te leiden:

1. `npm search @openclaw --json` en verzamel de pakketnamen.
2. Vergelijk met `extensions/*/package.json`-namen.
3. Publiceer alleen de **doorsnede** (al op npm).

Huidige npm-pluginlijst (bijwerken indien nodig):

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

Releasenotes moeten ook **nieuwe optionele gebundelde plugins** vermelden die **niet
standaard ingeschakeld** zijn (voorbeeld: `tlon`).
