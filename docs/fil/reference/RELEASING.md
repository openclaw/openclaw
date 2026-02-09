---
summary: "Hakbang-hakbang na checklist ng release para sa npm + macOS app"
read_when:
  - Nagka-cut ng bagong npm release
  - Nagka-cut ng bagong macOS app release
  - Nive-verify ang metadata bago mag-publish
---

# Checklist ng Release (npm + macOS)

Use `pnpm` (Node 22+) from the repo root. Keep the working tree clean before tagging/publishing.

## Operator trigger

Kapag sinabi ng operator na “release”, agad gawin ang preflight na ito (walang dagdag na tanong maliban kung may harang):

- Basahin ang doc na ito at ang `docs/platforms/mac/release.md`.
- I-load ang env mula sa `~/.profile` at kumpirmahing naka-set ang `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect vars (ang SPARKLE_PRIVATE_KEY_FILE ay dapat nasa `~/.profile`).
- Gamitin ang Sparkle keys mula sa `~/Library/CloudStorage/Dropbox/Backup/Sparkle` kung kailangan.

1. **Version & metadata**

- [ ] I-bump ang version ng `package.json` (hal., `2026.1.29`).
- [ ] Patakbuhin ang `pnpm plugins:sync` para i-align ang extension package versions + mga changelog.
- [ ] I-update ang CLI/version strings: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) at ang Baileys user agent sa [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Kumpirmahin ang package metadata (name, description, repository, keywords, license) at na ang `bin` map ay tumuturo sa [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) para sa `openclaw`.
- [ ] Kung may nagbago sa dependencies, patakbuhin ang `pnpm install` para updated ang `pnpm-lock.yaml`.

2. **Build & artifacts**

- [ ] Kung may nagbago sa A2UI inputs, patakbuhin ang `pnpm canvas:a2ui:bundle` at i-commit ang anumang na-update na [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (nire-regenerate ang `dist/`).
- [ ] I-verify na ang npm package `files` ay may kasamang lahat ng kinakailangang `dist/*` folders (lalo na ang `dist/node-host/**` at `dist/acp/**` para sa headless node + ACP CLI).
- [ ] Kumpirmahin na umiiral ang `dist/build-info.json` at kasama nito ang inaasahang `commit` hash (ginagamit ito ng CLI banner para sa npm installs).
- [ ] Opsyonal: `npm pack --pack-destination /tmp` pagkatapos ng build; suriin ang laman ng tarball at itabi ito para sa GitHub release (huwag **i-commit**).

3. **Changelog & docs**

- [ ] I-update ang `CHANGELOG.md` gamit ang mga highlight na pang-user (likhain ang file kung wala); panatilihing mahigpit na pababa ayon sa version ang mga entry.
- [ ] Tiyaking tugma ang mga README example/flag sa kasalukuyang behavior ng CLI (lalo na ang mga bagong command o opsyon).

4. **Validation**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (o `pnpm test:coverage` kung kailangan ng coverage output)
- [ ] `pnpm release:check` (bine-verify ang laman ng npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker install smoke test, mabilis na ruta; **kailangan** bago ang release)
  - Kung alam na sira ang agarang naunang npm release, i-set ang `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` o `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` para sa preinstall step.
- [ ] (Opsyonal) Full installer smoke (nagdadagdag ng non-root + CLI coverage): `pnpm test:install:smoke`
- [ ] (Opsyonal) Installer E2E (Docker, pinapatakbo ang `curl -fsSL https://openclaw.ai/install.sh | bash`, nag-o-onboard, tapos tumatakbo ng totoong tool calls):
  - `pnpm test:install:e2e:openai` (kailangan ang `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (kailangan ang `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (kailangan ang parehong key; pinapatakbo ang parehong provider)
- [ ] (Opsyonal) Spot-check ang web gateway kung naaapektuhan ng mga pagbabago ang send/receive paths.

5. **macOS app (Sparkle)**

- [ ] I-build + i-sign ang macOS app, pagkatapos ay i-zip ito para sa distribusyon.
- [ ] I-generate ang Sparkle appcast (HTML notes sa pamamagitan ng [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) at i-update ang `appcast.xml`.
- [ ] Ihanda ang app zip (at opsyonal na dSYM zip) para i-attach sa GitHub release.
- [ ] Sundin ang [macOS release](/platforms/mac/release) para sa eksaktong mga command at kinakailangang env vars.
  - Dapat numeric + monotonic ang `APP_BUILD` (walang `-beta`) para maikumpara nang tama ng Sparkle ang mga version.
  - Kung magno-notarize, gamitin ang `openclaw-notary` keychain profile na ginawa mula sa App Store Connect API env vars (tingnan ang [macOS release](/platforms/mac/release)).

6. **Publish (npm)**

- [ ] Kumpirmahing malinis ang git status; mag-commit at mag-push kung kailangan.
- [ ] `npm login` (i-verify ang 2FA) kung kailangan.
- [ ] `npm publish --access public` (gamitin ang `--tag beta` para sa pre-releases).
- [ ] I-verify ang registry: `npm view openclaw version`, `npm view openclaw dist-tags`, at `npx -y openclaw@X.Y.Z --version` (o `--help`).

### Pag-troubleshoot (mga tala mula sa 2.0.0-beta2 release)

- **npm pack/publish hangs or produces huge tarball**: the macOS app bundle in `dist/OpenClaw.app` (and release zips) get swept into the package. Fix by whitelisting publish contents via `package.json` `files` (include dist subdirs, docs, skills; exclude app bundles). Confirm with `npm pack --dry-run` that `dist/OpenClaw.app` is not listed.
- **npm auth web loop para sa dist-tags**: gamitin ang legacy auth para makakuha ng OTP prompt:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **Bumabagsak ang verification ng `npx` na may `ECOMPROMISED: Lock compromised`**: ulitin gamit ang sariwang cache:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Kailangang i-repoint ang tag matapos ang huling ayos**: i-force-update at i-push ang tag, pagkatapos tiyaking tugma pa rin ang mga asset ng GitHub release:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub release + appcast**

- [ ] I-tag at i-push: `git tag vX.Y.Z && git push origin vX.Y.Z` (o `git push --tags`).
- [ ] Gumawa/i-refresh ang GitHub release para sa `vX.Y.Z` na may **pamagat na `openclaw X.Y.Z`** (hindi lang ang tag); dapat isama ng body ang **buong** seksyon ng changelog para sa bersyong iyon (Highlights + Changes + Fixes), inline (walang bare links), at **huwag ulitin ang pamagat sa loob ng body**.
- [ ] I-attach ang mga artifact: `npm pack` tarball (opsyonal), `OpenClaw-X.Y.Z.zip`, at `OpenClaw-X.Y.Z.dSYM.zip` (kung na-generate).
- [ ] I-commit ang na-update na `appcast.xml` at i-push ito (kumukuha ang Sparkle mula sa main).
- [ ] Mula sa malinis na temp directory (walang `package.json`), patakbuhin ang `npx -y openclaw@X.Y.Z send --help` para kumpirmahing gumagana ang install/CLI entrypoints.
- [ ] I-announce/ibahagi ang release notes.

## Saklaw ng pag-publish ng plugin (npm)

We only publish **existing npm plugins** under the `@openclaw/*` scope. Bundled
plugins that are not on npm stay **disk-tree only** (still shipped in
`extensions/**`).

Proseso para buuin ang listahan:

1. `npm search @openclaw --json` at kunin ang mga pangalan ng package.
2. Ihambing sa mga pangalang `extensions/*/package.json`.
3. I-publish lamang ang **intersection** (mga nasa npm na).

Kasalukuyang listahan ng npm plugin (i-update kung kailangan):

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

Dapat ding banggitin ng release notes ang **mga bagong opsyonal na bundled plugin** na **hindi naka-on bilang default** (halimbawa: `tlon`).
