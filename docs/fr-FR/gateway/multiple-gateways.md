---
summary: "Exécuter plusieurs Passerelles OpenClaw sur un hôte (isolation, ports et profils)"
read_when:
  - Exécution de plus d'une Passerelle sur la même machine
  - Vous avez besoin de config/état/ports isolés par Passerelle
title: "Passerelles multiples"
---

# Passerelles multiples (même hôte)

La plupart des configurations devraient utiliser une Passerelle car une seule Passerelle peut gérer plusieurs connexions de messagerie et agents. Si vous avez besoin d'une isolation plus forte ou de redondance (par exemple, un bot de secours), exécutez des Passerelles séparées avec des profils/ports isolés.

## Liste de vérification d'isolation (requis)

- `OPENCLAW_CONFIG_PATH` — fichier de config par instance
- `OPENCLAW_STATE_DIR` — sessions, creds, caches par instance
- `agents.defaults.workspace` — racine de workspace par instance
- `gateway.port` (ou `--port`) — unique par instance
- Les ports dérivés (navigateur/canvas) ne doivent pas se chevaucher

Si ceux-ci sont partagés, vous rencontrerez des courses de config et des conflits de port.

## Recommandé : profils (`--profile`)

Les profils scopent automatiquement `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` et suffixent les noms de service.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Services par profil :

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Guide bot de secours

Exécutez une seconde Passerelle sur le même hôte avec ses propres :

- profil/config
- répertoire d'état
- workspace
- port de base (plus ports dérivés)

Cela garde le bot de secours isolé du bot principal afin qu'il puisse déboguer ou appliquer des changements de config si le bot primaire est en panne.

Espacement de port : laissez au moins 20 ports entre les ports de base pour que les ports dérivés navigateur/canvas/CDP ne se chevauchent jamais.

### Comment installer (bot de secours)

```bash
# Bot principal (existant ou frais, sans param --profile)
# S'exécute sur le port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Bot de secours (profil isolé + ports)
openclaw --profile rescue onboard
# Notes :
# - le nom de workspace sera postfixé avec -rescue par défaut
# - Le port devrait être au moins 18789 + 20 Ports,
#   mieux vaut choisir un port de base complètement différent, comme 19789,
# - le reste de l'intégration est le même que normal

# Pour installer le service (si pas arrivé automatiquement pendant l'intégration)
openclaw --profile rescue gateway install
```

## Mappage de port (dérivés)

Port de base = `gateway.port` (ou `OPENCLAW_GATEWAY_PORT` / `--port`).

- port de service de contrôle navigateur = base + 2 (loopback uniquement)
- l'hôte canvas est servi sur le serveur HTTP Passerelle (même port que `gateway.port`)
- Les ports CDP de profil navigateur s'auto-allouent depuis `browser.controlPort + 9 .. + 108`

Si vous remplacez l'un de ces éléments dans la config ou env, vous devez les garder uniques par instance.

## Notes navigateur/CDP (piège courant)

- Ne **pas** épingler `browser.cdpUrl` aux mêmes valeurs sur plusieurs instances.
- Chaque instance a besoin de son propre port de contrôle navigateur et plage CDP (dérivée de son port passerelle).
- Si vous avez besoin de ports CDP explicites, définissez `browser.profiles.<name>.cdpPort` par instance.
- Chrome distant : utilisez `browser.profiles.<name>.cdpUrl` (par profil, par instance).

## Exemple env manuel

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Vérifications rapides

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
