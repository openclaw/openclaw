---
summary: "Étapes de signature pour les builds de débogage macOS générés par les scripts de packaging"
read_when:
  - Création ou signature de builds mac de débogage
title: "Signature macOS"
---

# signature mac (builds de débogage)

Cette application est généralement construite à partir de [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), qui désormais :

- définit un identifiant de bundle de débogage stable : `ai.openclaw.mac.debug`
- écrit l’Info.plist avec cet identifiant de bundle (remplacement via `BUNDLE_ID=...`)
- appelle [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) pour signer le binaire principal et le bundle de l’app afin que macOS traite chaque reconstruction comme le même bundle signé et conserve les autorisations TCC (notifications, accessibilité, enregistrement d’écran, micro, dictée). Pour des autorisations stables, utilisez une identité de signature réelle ; la signature ad‑hoc est optionnelle et fragile (voir [autorisations macOS](/platforms/mac/permissions)).
- utilise `CODESIGN_TIMESTAMP=auto` par défaut ; cela active les horodatages de confiance pour les signatures Developer ID. Définissez `CODESIGN_TIMESTAMP=off` pour ignorer l’horodatage (builds de débogage hors ligne).
- injecte des métadonnées de build dans l’Info.plist : `OpenClawBuildTimestamp` (UTC) et `OpenClawGitCommit` (hash court) afin que le panneau « À propos » puisse afficher le build, le git et le canal débogage/release.
- **Le packaging nécessite Node 22+** : le script exécute les builds TS et le build de l’interface Control UI.
- lit `SIGN_IDENTITY` depuis l’environnement. Ajoutez `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (ou votre certificat Developer ID Application) à votre rc de shell pour toujours signer avec votre certificat. La signature ad‑hoc nécessite un opt‑in explicite via `ALLOW_ADHOC_SIGNING=1` ou `SIGN_IDENTITY="-"` (non recommandé pour tester les autorisations).
- exécute un audit d’ID d’équipe après la signature et échoue si un Mach‑O quelconque à l’intérieur du bundle de l’app est signé par un ID d’équipe différent. Définissez `SKIP_TEAM_ID_CHECK=1` pour contourner.

## Utilisation

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Note sur la signature ad‑hoc

Lors de la signature avec `SIGN_IDENTITY="-"` (ad‑hoc), le script désactive automatiquement le **Hardened Runtime** (`--options runtime`). C’est nécessaire pour éviter des crashs lorsque l’app tente de charger des frameworks embarqués (comme Sparkle) qui ne partagent pas le même ID d’équipe. Les signatures ad‑hoc rompent également la persistance des autorisations TCC ; voir [autorisations macOS](/platforms/mac/permissions) pour les étapes de récupération.

## Construire des métadonnées pour A propos

`package-mac-app.sh` estampille le bundle avec :

- `OpenClawBuildTimestamp` : ISO8601 UTC au moment du packaging
- `OpenClawGitCommit` : hash git court (ou `unknown` si indisponible)

L’onglet « À propos » lit ces clés pour afficher la version, la date de build, le commit git et s’il s’agit d’un build de débogage (via `#if DEBUG`). Exécutez le packager pour actualiser ces valeurs après des changements de code.

## Pourquoi

Les autorisations TCC sont liées à l’identifiant de bundle _et_ à la signature du code. Les builds de débogage non signés avec des UUID changeants faisaient que macOS oubliait les autorisations après chaque reconstruction. Signer les binaires (ad‑hoc par défaut) et conserver un identifiant/chemin de bundle fixe (`dist/OpenClaw.app`) préserve les autorisations entre les builds, conformément à l’approche VibeTunnel.
