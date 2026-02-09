---
summary: "Executer plusieurs Gateway OpenClaw sur un même hôte (isolation, ports et profils)"
read_when:
  - Exécuter plus d'une Gateway sur la même machine
  - Vous avez besoin d'une configuration/d'un état/dés ports isolés par Gateway
title: "Plusieurs Gateways"
---

# Plusieurs Gateways (même hôte)

La plupart des configurations devraient utiliser une seule Gateway, car une Gateway unique peut gérer plusieurs connexions de messagerie et agents. Si vous avez besoin d'une isolation ou d'une redondance plus fortes (par exemple, un bot de secours), exécutez des Gateways séparées avec des profils et des ports isolés.

## Liste de contrôle d'isolation (obligatoire)

- `OPENCLAW_CONFIG_PATH` — fichier de configuration par instance
- `OPENCLAW_STATE_DIR` — sessions, identifiants et caches par instance
- `agents.defaults.workspace` — racine de l'espace de travail par instance
- `gateway.port` (ou `--port`) — unique par instance
- Les ports dérivés (navigateur/canvas) ne doivent pas se chevaucher

Si ces éléments sont partagés, vous rencontrerez des conflits de configuration et de ports.

## Recommandé : profils (`--profile`)

Les profils délimitent automatiquement `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` et ajoutent un suffixe aux noms de service.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Services par profil :

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Guide du bot de secours

Exécutez une deuxième Gateway sur le même hôte avec ses propres :

- profil/configuration
- répertoire d'état
- espace de travail
- port de base (plus les ports dérivés)

Cela maintient le bot de secours isolé du bot principal afin qu'il puisse déboguer ou appliquer des changements de configuration si le bot principal est hors service.

Espacement des ports : laissez au moins 20 ports entre les ports de base afin que les ports dérivés du navigateur/canvas/CDP n'entrent jamais en collision.

### Comment installer (bot de secours)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Mappage des ports (dérivés)

Port de base = `gateway.port` (ou `OPENCLAW_GATEWAY_PORT` / `--port`).

- port du service de contrôle du navigateur = base + 2 (loopback uniquement)
- `canvasHost.port = base + 4`
- Les ports CDP du profil de navigateur s'allouent automatiquement à partir de `browser.controlPort + 9 .. + 108`

Si vous remplacez l'un de ces paramètres dans la configuration ou les variables d'environnement, vous devez les maintenir uniques par instance.

## Notes sur le navigateur/CDP (piège courant)

- Ne **fixez pas** `browser.cdpUrl` aux mêmes valeurs sur plusieurs instances.
- Chaque instance a besoin de son propre port de contrôle du navigateur et de sa propre plage CDP (dérivés de son port de gateway).
- Si vous avez besoin de ports CDP explicites, définissez `browser.profiles.<name>.cdpPort` par instance.
- Chrome distant : utilisez `browser.profiles.<name>.cdpUrl` (par profil, par instance).

## Exemple manuel avec variables d'environnement

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
