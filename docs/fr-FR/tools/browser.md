---
summary: "Service contrôle navigateur intégré + commandes action"
read_when:
  - Ajout automatisation navigateur contrôlée par agent
  - Débogage pourquoi openclaw interfère avec votre propre Chrome
  - Implémentation paramètres navigateur + cycle de vie dans app macOS
title: "Navigateur (géré par OpenClaw)"
---

# Navigateur (géré par openclaw)

OpenClaw peut exécuter un **profil Chrome/Brave/Edge/Chromium dédié** que l'agent contrôle. Il est isolé de votre navigateur personnel et est géré via un petit service de contrôle local dans la Passerelle (loopback uniquement).

Vue débutant :

- Pensez-y comme un **navigateur séparé, agent uniquement**.
- Le profil `openclaw` ne **touche pas** votre profil navigateur personnel.
- L'agent peut **ouvrir onglets, lire pages, cliquer et taper** dans une voie sûre.
- Le profil `chrome` par défaut utilise le **navigateur Chromium système par défaut** via le relais d'extension ; basculez vers `openclaw` pour le navigateur géré isolé.

## Ce que vous obtenez

- Un profil navigateur séparé nommé **openclaw** (accent orange par défaut).
- Contrôle onglet déterministe (lister/ouvrir/focus/fermer).
- Actions agent (cliquer/taper/glisser/sélectionner), snapshots, captures d'écran, PDFs.
- Support multi-profils optionnel (`openclaw`, `work`, `remote`, ...).

Ce navigateur n'est **pas** votre pilote quotidien. C'est une surface sûre et isolée pour automatisation et vérification agent.

## Démarrage rapide

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Si vous obtenez "Browser disabled", activez-le dans la config (voir ci-dessous) et redémarrez la Passerelle.

## Profils : `openclaw` vs `chrome`

- `openclaw` : navigateur géré, isolé (aucune extension requise).
- `chrome` : relais extension vers votre **navigateur système** (nécessite l'extension OpenClaw attachée à un onglet).

Définissez `browser.defaultProfile: "openclaw"` si vous voulez le mode géré par défaut.

## Configuration

Les paramètres navigateur vivent dans `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // défaut : true
    // cdpUrl: "http://127.0.0.1:18792", // remplacement legacy profil unique
    remoteCdpTimeoutMs: 1500, // timeout HTTP CDP distant (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // timeout handshake WebSocket CDP distant (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Notes :

- Le service contrôle navigateur se lie à loopback sur un port dérivé de `gateway.port` (par défaut : `18791`, qui est gateway + 2). Le relais utilise le port suivant (`18792`).
- Si vous remplacez le port Passerelle (`gateway.port` ou `OPENCLAW_GATEWAY_PORT`), les ports navigateur dérivés se déplacent pour rester dans la même "famille".
- `cdpUrl` utilise par défaut le port relais quand non défini.
- `remoteCdpTimeoutMs` s'applique aux vérifications accessibilité CDP distantes (non-loopback).
- `remoteCdpHandshakeTimeoutMs` s'applique aux vérifications accessibilité WebSocket CDP distantes.
- `attachOnly: true` signifie "ne jamais lancer un navigateur local ; attacher uniquement s'il fonctionne déjà."
- `color` + `color` par profil teintent l'UI navigateur pour que vous puissiez voir quel profil est actif.
- Le profil par défaut est `chrome` (relais extension). Utilisez `defaultProfile: "openclaw"` pour le navigateur géré.
- Ordre auto-détection : navigateur système par défaut si basé Chromium ; sinon Chrome → Brave → Edge → Chromium → Chrome Canary.
- Les profils `openclaw` locaux attribuent automatiquement `cdpPort`/`cdpUrl` — définissez-les uniquement pour CDP distant.

## Utiliser Brave (ou un autre navigateur basé Chromium)

Si votre navigateur **système par défaut** est basé Chromium (Chrome/Brave/Edge/etc), OpenClaw l'utilise automatiquement. Définissez `browser.executablePath` pour remplacer l'auto-détection :

Exemple CLI :

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Contrôle local vs distant

- **Contrôle local (par défaut) :** la Passerelle démarre le service contrôle loopback et peut lancer un navigateur local.
- **Contrôle distant (hôte nœud) :** exécutez un hôte nœud sur la machine qui a le navigateur ; la Passerelle proxie les actions navigateur vers lui.
- **CDP distant :** définissez `browser.profiles.<name>.cdpUrl` (ou `browser.cdpUrl`) pour attacher à un navigateur basé Chromium distant. Dans ce cas, OpenClaw ne lancera pas de navigateur local.

Les URLs CDP distantes peuvent inclure l'auth :

- Jetons query (par ex., `https://provider.example?token=<token>`)
- Auth Basic HTTP (par ex., `https://user:pass@provider.example`)

OpenClaw préserve l'auth lors de l'appel des points de terminaison `/json/*` et lors de la connexion au WebSocket CDP. Préférez les variables d'environnement ou gestionnaires secrets pour les jetons au lieu de les committer dans les fichiers de config.

## Proxy navigateur nœud (par défaut zéro-config)

Si vous exécutez un **hôte nœud** sur la machine qui a votre navigateur, OpenClaw peut auto-router les appels outil navigateur vers ce nœud sans config navigateur extra. C'est le chemin par défaut pour les passerelles distantes.

## Actions navigateur

L'agent peut effectuer ces actions :

- `open` : Ouvrir URL
- `close` : Fermer onglet
- `focus` : Focus onglet
- `snapshot` : Capturer snapshot DOM
- `screenshot` : Prendre capture d'écran
- `pdf` : Générer PDF
- `click` : Cliquer élément
- `type` : Taper texte
- `select` : Sélectionner texte
- `drag` : Glisser élément
