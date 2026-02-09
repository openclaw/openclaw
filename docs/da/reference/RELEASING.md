---
summary: "Trin-for-trin tjekliste for udgivelse af npm + macOS-app"
read_when:
  - Udgivelse af en ny npm-version
  - Udgivelse af en ny macOS-app-version
  - Verifikation af metadata før publicering
---

# Release-tjekliste (npm + macOS)

Brug `pnpm` (Node 22+) fra repo roden. Hold arbejdstræet rent før tagging/publicering.

## Operator-trigger

Når operatøren siger “release”, skal du straks lave denne preflight (ingen ekstra spørgsmål medmindre blokeret):

- Læs dette dokument og `docs/platforms/mac/release.md`.
- Indlæs env fra `~/.profile` og bekræft, at `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect-variabler er sat (SPARKLE_PRIVATE_KEY_FILE skal ligge i `~/.profile`).
- Brug Sparkle-nøgler fra `~/Library/CloudStorage/Dropbox/Backup/Sparkle` hvis nødvendigt.

1. **Version & metadata**

- [ ] Forøg `package.json`-versionen (fx `2026.1.29`).
- [ ] Kør `pnpm plugins:sync` for at afstemme versionsnumre og changelogs for extensions.
- [ ] Opdatér CLI-/versionsstrenge: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) og Baileys user agent i [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Bekræft pakke-metadata (navn, beskrivelse, repository, keywords, licens), og at `bin`-mappet peger på [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) for `openclaw`.
- [ ] Hvis afhængigheder er ændret, kør `pnpm install`, så `pnpm-lock.yaml` er opdateret.

2. **Build & artefakter**

- [ ] Hvis A2UI-inputs er ændret, kør `pnpm canvas:a2ui:bundle` og commit eventuelle opdaterede [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (regenererer `dist/`).
- [ ] Verificér at npm-pakken `files` indeholder alle nødvendige `dist/*`-mapper (især `dist/node-host/**` og `dist/acp/**` til headless node + ACP CLI).
- [ ] Bekræft at `dist/build-info.json` findes og indeholder den forventede `commit`-hash (CLI-banneret bruger dette til npm-installationer).
- [ ] Valgfrit: `npm pack --pack-destination /tmp` efter build; inspicér tarball-indholdet og gem det til GitHub-releasen (commit det **ikke**).

3. **Changelog & docs**

- [ ] Opdatér `CHANGELOG.md` med brugerrettede highlights (opret filen hvis den mangler); hold indgange strengt faldende efter version.
- [ ] Sørg for, at README-eksempler/flags matcher den aktuelle CLI-adfærd (især nye kommandoer eller muligheder).

4. **Validering**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (eller `pnpm test:coverage` hvis du har brug for coverage-output)
- [ ] `pnpm release:check` (verificerer npm pack-indhold)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker-installations-smoke test, hurtig sti; påkrævet før release)
  - Hvis den umiddelbart forrige npm-release vides at være defekt, sæt `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` eller `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` for preinstall-trinnet.
- [ ] (Valgfrit) Fuld installer-smoke (tilføjer non-root + CLI-dækning): `pnpm test:install:smoke`
- [ ] (Valgfrit) Installer E2E (Docker, kører `curl -fsSL https://openclaw.ai/install.sh | bash`, onboarder og kører derefter rigtige tool-kald):
  - `pnpm test:install:e2e:openai` (kræver `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (kræver `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (kræver begge nøgler; kører begge providers)
- [ ] (Valgfrit) Spot-tjek web-gatewayen, hvis dine ændringer påvirker send/modtag-stier.

5. **macOS-app (Sparkle)**

- [ ] Build og signér macOS-appen, og zip den derefter til distribution.
- [ ] Generér Sparkle-appcast (HTML-noter via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) og opdatér `appcast.xml`.
- [ ] Hold app zip (og valgfri dSYM zip) klar til at vedhæfte til GitHub udgivelse.
- [ ] Følg [macOS release](/platforms/mac/release) for de præcise kommandoer og påkrævede env-vars.
  - `APP_BUILD` skal være numerisk og monoton (ingen `-beta`), så Sparkle sammenligner versioner korrekt.
  - Hvis der notariseres, brug `openclaw-notary`-keychain-profilen oprettet fra App Store Connect API env-vars (se [macOS release](/platforms/mac/release)).

6. **Publicér (npm)**

- [ ] Bekræft at git-status er ren; commit og push efter behov.
- [ ] `npm login` (verificér 2FA) hvis nødvendigt.
- [ ] `npm publish --access public` (brug `--tag beta` til pre-releases).
- [ ] Verificér registreret: `npm view openclaw version`, `npm view openclaw dist-tags` og `npx -y openclaw@X.Y.Z --version` (eller `--help`).

### Fejlfinding (noter fra 2.0.0-beta2-release)

- **npm pack/publish hangs or produces huge tarball**: macOS app bundle in `dist/OpenClaw.app` (og release zips) bliver fejet ind i pakken. Fix ved whitelisting publicere indhold via `package.json` `files` (omfatter dist subdirs, docs, færdigheder; udelukke app bundter). Bekræft med `npm pack --dry-run` at `dist/OpenClaw.app` ikke er angivet.
- **npm auth web-loop for dist-tags**: brug legacy-auth for at få en OTP-prompt:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx`-verifikation fejler med `ECOMPROMISED: Lock compromised`**: prøv igen med en frisk cache:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tag skal peges om efter en sen rettelse**: force-opdatér og push tagget, og sørg derefter for, at GitHub-release-artefakterne stadig matcher:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub-release + appcast**

- [ ] Tag og push: `git tag vX.Y.Z && git push origin vX.Y.Z` (eller `git push --tags`).
- [ ] Opret/opdatér GitHub-releasen for `vX.Y.Z` med **titel `openclaw X.Y.Z`** (ikke kun tagget); brødteksten skal indeholde **den fulde** changelog-sektion for den version (Highlights + Changes + Fixes), inline (ingen bare links), og **må ikke gentage titlen inde i brødteksten**.
- [ ] Vedhæft artefakter: `npm pack`-tarball (valgfrit), `OpenClaw-X.Y.Z.zip` og `OpenClaw-X.Y.Z.dSYM.zip` (hvis genereret).
- [ ] Commit den opdaterede `appcast.xml` og push den (Sparkle feeder fra main).
- [ ] Fra en ren temp-mappe (ingen `package.json`), kør `npx -y openclaw@X.Y.Z send --help` for at bekræfte, at install/CLI-entrypoints virker.
- [ ] Annoncér/del release-noter.

## Plugin-publiceringsscope (npm)

Vi offentliggør kun **eksisterende npm plugins** under `@openclaw/*` anvendelsesområdet. Medfølgende
plugins, der ikke er på npm ophold **disk-tree kun** (stadig afsendt i
`extensions/**`).

Proces for at aflede listen:

1. `npm search @openclaw --json` og indfang pakkenavnene.
2. Sammenlign med `extensions/*/package.json`-navne.
3. Publicér kun **snittet** (allerede på npm).

Aktuel liste over npm-plugins (opdatér efter behov):

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

Release-noter skal også fremhæve **nye valgfrie bundtede plugins**, der **ikke er
slået til som standard** (eksempel: `tlon`).
