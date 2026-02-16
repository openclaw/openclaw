---
summary: "Étapes signature pour builds debug macOS générés par scripts packaging"
read_when:
  - Build ou signature builds debug mac
title: "Signature macOS"
---

# Signature mac (builds debug)

Cette app est habituellement construite depuis [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), qui maintenant :

- définit identifiant bundle debug stable : `ai.openclaw.mac.debug`
- écrit Info.plist avec ce bundle id (override via `BUNDLE_ID=...`)
- appelle [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) pour signer binaire main et bundle app donc macOS traite chaque rebuild comme même bundle signé et garde permissions TCC (notifications, accessibility, screen recording, mic, speech). Pour permissions stables, utilisez vraie identité signature ; ad-hoc est opt-in et fragile (voir [permissions macOS](/fr-FR/platforms/mac/permissions)).
- utilise `CODESIGN_TIMESTAMP=auto` par défaut ; active timestamps trusted pour signatures Developer ID. Définissez `CODESIGN_TIMESTAMP=off` pour sauter timestamping (builds debug offline).
- injecte métadonnées build dans Info.plist : `OpenClawBuildTimestamp` (UTC) et `OpenClawGitCommit` (hash court) donc panneau About peut montrer build, git et canal debug/release.
- **Packaging nécessite Node 22+** : script exécute builds TS et build Control UI.
- lit `SIGN_IDENTITY` depuis environnement. Ajoutez `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (ou votre cert Developer ID Application) à votre shell rc pour toujours signer avec votre cert. Signature ad-hoc nécessite opt-in explicite via `ALLOW_ADHOC_SIGNING=1` ou `SIGN_IDENTITY="-"` (non recommandé pour test permission).

## Usage

```bash
# depuis racine repo
scripts/package-mac-app.sh               # auto-sélectionne identité ; erreur si aucune trouvée
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # vrai cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions ne colleront pas)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # ad-hoc explicite (même caveat)
```

### Note Signature Ad-hoc

Quand signature avec `SIGN_IDENTITY="-"` (ad-hoc), script désactive automatiquement **Hardened Runtime** (`--options runtime`). Nécessaire pour prévenir crashes quand app tente charger frameworks embarqués (comme Sparkle) qui ne partagent pas même Team ID. Signatures ad-hoc cassent aussi persistance permission TCC ; voir [permissions macOS](/fr-FR/platforms/mac/permissions) pour étapes récupération.

## Métadonnées Build pour About

`package-mac-app.sh` stampe bundle avec :

- `OpenClawBuildTimestamp` : ISO8601 UTC au moment package
- `OpenClawGitCommit` : hash git court (ou `unknown` si indisponible)

Onglet About lit ces clés pour montrer version, date build, commit git et si c'est build debug (via `#if DEBUG`). Exécutez packager pour rafraîchir ces valeurs après changements code.

Voir aussi :

- [Release macOS](/fr-FR/platforms/mac/release)
- [Permissions](/fr-FR/platforms/mac/permissions)
- [App macOS](/fr-FR/platforms/macos)
