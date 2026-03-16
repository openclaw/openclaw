---
summary: "Extension Chrome : laisser OpenClaw driver votre onglet Chrome existant"
read_when:
  - Vous voulez agent driver onglet Chrome existant (bouton toolbar)
  - Vous avez besoin Passerelle distante + automation browser locale via Tailscale
  - Vous voulez comprendre implications sécurité takeover browser
title: "Extension Chrome"
---

# Extension Chrome (relay browser)

Extension Chrome OpenClaw laisse agent contrôler vos **onglets Chrome existants** (votre fenêtre Chrome normale) au lieu lancer profil Chrome séparé openclaw-managed.

Attach/detach arrive via **bouton toolbar Chrome unique**.

## Qu'est-ce (concept)

Il y a trois parts :

- **Service contrôle browser** (Passerelle ou node) : API que agent/tool appelle (via Passerelle)
- **Serveur relay local** (loopback CDP) : bridge entre serveur contrôle et extension (`http://127.0.0.1:18792` par défaut)
- **Extension Chrome MV3** : attache à onglet actif utilisant `chrome.debugger` et pipe messages CDP vers relay

OpenClaw contrôle alors onglet attaché via surface tool `browser` normale (sélectionnant profil correct).

## Install / load (unpacked)

1. Installer extension vers path local stable :

```bash
openclaw browser extension install
```

2. Imprimer path répertoire extension installé :

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Activer "Developer mode"
- "Load unpacked" → sélectionner répertoire imprimé ci-dessus

4. Pin extension.

## Updates (pas step build)

Extension ship dans release OpenClaw (package npm) comme fichiers statiques. Pas step "build" séparé.

Après upgrade OpenClaw :

- Re-run `openclaw browser extension install` pour refresh fichiers installés sous répertoire state OpenClaw.
- Chrome → `chrome://extensions` → cliquer "Reload" sur extension.

## Utiliser (pas config extra)

OpenClaw ship avec profil browser builtin nommé `chrome` qui cible relay extension sur port défaut.

Utilisez :

- CLI : `openclaw browser --browser-profile chrome tabs`
- Tool agent : `browser` avec `profile="chrome"`

Si vous voulez nom différent ou port relay différent, créez propre profil :

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Attach / detach (bouton toolbar)

- Ouvrir onglet que vous voulez OpenClaw contrôler.
- Cliquer icône extension.
  - Badge affiche `ON` quand attaché.
- Cliquer encore pour détacher.

## Remote Gateway + browser local

Extension utile pour topologies remote :

- **Passerelle remote** : tourne sur VPS/exe.dev via Tailscale
- **Browser local** : Chrome/Brave sur votre Mac/PC

Flux :

1. Agent (remote) appelle tool `browser`
2. Passerelle forward vers node local via Tailscale
3. Node bridge vers serveur relay extension (`127.0.0.1:18792`)
4. Extension contrôle onglet via Chrome DevTools Protocol

Config :

```json5
{
  browser: {
    profiles: {
      chrome: {
        driver: "extension",
        cdpUrl: "http://127.0.0.1:18792",
      },
    },
  },
  nodes: {
    list: [
      {
        id: "mac",
        tailscaleHostname: "macbook-pro",
        services: ["browser"],
      },
    ],
  },
}
```

## Implications sécurité

Extension obtient accès **complet** onglet attaché :

- Lire contenu page complet
- Injecter JavaScript
- Intercepter requêtes network
- Accéder cookies/storage

**Recommandations :**

- Utilisez profil Chrome séparé pour OpenClaw
- N'attachez pas onglets avec données sensibles
- Détachez quand pas besoin contrôle
- Considérez utiliser profils browser distincts pour travail différent

## Dépannage

**Extension pas connecte :**

```bash
# Vérifier relay server tourne
openclaw browser relay status

# Démarrer relay manuellement
openclaw browser relay start --port 18792
```

**Badge montre "ERROR" :**

- Vérifier port relay pas bloqué
- Vérifier pas autres extensions conflictuelles
- Reload extension via `chrome://extensions`

**Commandes pas exécutent :**

```bash
# Vérifier profil configuré
openclaw config get browser.profiles.chrome

# Tester connection directe
curl http://127.0.0.1:18792/json
```

## Architecture technique

```
┌─────────┐           ┌──────────┐           ┌──────────┐
│ Agent   │──browser─>│ Gateway  │──────────>│ Node     │
│         │   tool    │          │ Tailscale │ (local)  │
└─────────┘           └──────────┘           └────┬─────┘
                                                   │
                                                   v
                                            ┌──────────┐
                                            │ Relay    │
                                            │ :18792   │
                                            └────┬─────┘
                                                 │ CDP
                                                 v
                                          ┌─────────────┐
                                          │ Extension   │
                                          │ (active tab)│
                                          └─────────────┘
```

Voir aussi :

- [Browser](/fr-FR/tools/browser)
- [Nodes](/fr-FR/nodes/index)
- [Tailscale](/fr-FR/gateway/tailscale)
- [Troubleshooting Browser Linux](/fr-FR/tools/browser-linux-troubleshooting)
