---
title: "Checklist Release"
summary: "Checklist step-by-step release pour npm + app macOS"
read_when:
  - Couper nouveau release npm
  - Couper nouveau release app macOS
  - Vérifier metadata avant publish
---

# Checklist Release (npm + macOS)

Utilisez `pnpm` (Node 22+) depuis racine repo. Gardez arbre travail clean avant tagging/publishing.

## Trigger opérateur

Quand opérateur dit "release", faites immédiatement ce preflight (pas questions extra sauf blocage) :

- Lire ce doc et `docs/platforms/mac/release.md`.
- Charger env depuis `~/.profile` et confirmer `SPARKLE_PRIVATE_KEY_FILE` + vars App Store Connect définies (SPARKLE_PRIVATE_KEY_FILE devrait vivre dans `~/.profile`).
- Utiliser clés Sparkle depuis `~/Library/CloudStorage/Dropbox/Backup/Sparkle` si nécessaire.

1. **Version & metadata**

- [ ] Bumper version `package.json` (ex : `2026.1.29`).
- [ ] Run `pnpm plugins:sync` pour aligner versions + changelogs package extension.
- [ ] Mettre à jour strings CLI/version : [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) et user agent Baileys dans [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Confirmer metadata package (name, description, repository, keywords, license) et map `bin` pointe vers [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) pour `openclaw`.
- [ ] Si dépendances changées, run `pnpm install` pour `pnpm-lock.yaml` à jour.

2. **Build & artifacts**

- [ ] Si inputs A2UI changés, run `pnpm canvas:a2ui:bundle` et commit [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) mis à jour.
- [ ] `pnpm run build` (régénère `dist/`).
- [ ] Vérifier package npm `files` inclut tous dossiers `dist/*` requis (notamment `dist/node-host/**` et `dist/acp/**` pour node headless + ACP CLI).
- [ ] Confirmer `dist/build-info.json` existe et inclut hash `commit` attendu (CLI banner utilise pour installs npm).
- [ ] Optionnel : `npm pack --pack-destination /tmp` après build ; inspecter contenu tarball et garder pour release GitHub (ne **pas** commit).

3. **Changelog & docs**

- [ ] Mettre à jour `CHANGELOG.md` avec highlights user-facing (créer fichier si manquant) ; garder entrées strictement descendantes par version.
- [ ] Assurer exemples/flags README matchent comportement CLI actuel (notamment nouvelles commandes ou options).

4. **Validation**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (ou `pnpm test:coverage` si besoin output coverage)
- [ ] `pnpm release:check` (vérifie contenu npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (test smoke install Docker, fast path ; requis avant release)
  - Si release npm précédent immédiat known broken, définir `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` ou `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` pour étape preinstall.
- [ ] (Optionnel) Smoke installer complet (ajoute non-root + couverture CLI) : `pnpm test:install:smoke`
- [ ] (Optionnel) E2E installer (Docker, run `curl -fsSL https://openclaw.ai/install.sh | bash`, onboard, puis run appels tool réels) :
  - `pnpm test:install:e2e:openai` (nécessite `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (nécessite `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (nécessite les deux clés ; run les deux providers)
- [ ] (Optionnel) Spot-check passerelle web si changements affectent paths send/receive.

5. **App macOS (Sparkle)**

- [ ] Build + sign app macOS, puis zip pour distribution.
- [ ] Générer appcast Sparkle (notes HTML via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) et mettre à jour `appcast.xml`.
- [ ] Garder zip app (et optionnel zip dSYM) prêt attacher à release GitHub.
- [ ] Suivre [Release macOS](/fr-FR/platforms/mac/release) pour commandes exactes et vars env requises.
  - `APP_BUILD` doit être numérique + monotone (pas `-beta`) pour Sparkle comparer versions correctement.
  - Si notarization, utiliser profil keychain `openclaw-notary` créé depuis vars env API App Store Connect (voir [Release macOS](/fr-FR/platforms/mac/release)).

6. **Publish (npm)**

- [ ] Confirmer statut git clean ; commit et push si nécessaire.
- [ ] `npm login` (vérifier 2FA) si nécessaire.
- [ ] `npm publish --access public` (utiliser `--tag beta` pour pre-releases).
- [ ] Vérifier registry : `npm view openclaw version`, `npm view openclaw dist-tags` et `npx -y openclaw@X.Y.Z --version` (ou `--help`).

### Troubleshooting (notes depuis release 2.0.0-beta2)

- **npm pack/publish hang ou produit tarball énorme** : bundle app macOS dans `dist/OpenClaw.app` (et zips release) balayés dans package. Fix en whitelistant contenu publish via `files` `package.json` (inclure subdirs dist, docs, skills ; exclure bundles app). Confirmer avec `npm pack --dry-run` que `dist/OpenClaw.app` pas listé.
- **Boucle web auth npm pour dist-tags** : utiliser legacy auth pour obtenir prompt OTP :
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **Vérification `npx` échoue avec `ECOMPROMISED: Lock compromised`** : retry avec cache frais :
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tag besoin repointing après fix tardif** : force-update et push tag, puis assurer assets release GitHub matchent toujours :
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **Release GitHub + appcast**

- [ ] Tag et push : `git tag vX.Y.Z && git push origin vX.Y.Z` (ou `git push --tags`).
- [ ] Créer/refresh release GitHub pour `vX.Y.Z` avec **titre `openclaw X.Y.Z`** (pas juste tag) ; body devrait inclure section changelog **complète** pour version (Highlights + Changes + Fixes), inline (pas liens nus), et **ne doit pas répéter titre dans body**.
- [ ] Attacher artifacts : tarball `npm pack` (optionnel), `OpenClaw-X.Y.Z.zip` et `OpenClaw-X.Y.Z.dSYM.zip` (si généré).
- [ ] Commit `appcast.xml` mis à jour et push (Sparkle feed depuis main).
- [ ] Depuis répertoire temp clean (pas `package.json`), run `npx -y openclaw@X.Y.Z send --help` pour confirmer entrypoints install/CLI marchent.
- [ ] Annoncer/partager notes release.

## Scope publish plugin (npm)

Nous publions seulement **plugins npm existants** sous scope `@openclaw/*`. Plugins bundled pas sur npm restent **disk-tree seulement** (toujours shipped dans `extensions/**`).

Voir aussi :

- [Release macOS](/fr-FR/platforms/mac/release)
- [Testing](/fr-FR/help/testing)
