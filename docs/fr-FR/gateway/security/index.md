---
summary: "Considérations sécurité et modèle menaces pour exécution passerelle AI avec accès shell"
read_when:
  - Ajout fonctionnalités élargissant accès ou automation
title: "Sécurité"
---

# Sécurité 🔒

## Check rapide : `openclaw security audit`

Voir aussi : [Vérification Formelle (Modèles Sécurité)](/fr-FR/security/formal-verification/)

Exécutez régulièrement (spécialement après changement config ou exposition surfaces réseau) :

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Il flag footguns courants (exposition auth Passerelle, exposition contrôle browser, allowlists elevated, permissions filesystem).

`--fix` applique guardrails sûrs :

- Resserrer `groupPolicy="open"` vers `groupPolicy="allowlist"` (et variantes per-account) pour canaux courants.
- Retourner `logging.redactSensitive="off"` vers `"tools"`.
- Resserrer perms locales (`~/.openclaw` → `700`, fichier config → `600`, plus fichiers état courants comme `credentials/*.json`, `agents/*/agent/auth-profiles.json` et `agents/*/sessions/sessions.json`).

Exécuter agent AI avec accès shell sur votre machine est... _épicé_. Voici comment ne pas se faire pwner.

OpenClaw est produit et expérience : vous câblez comportement modèle frontier dans surfaces messaging réelles et outils réels. **Il n'y a pas setup "parfaitement sécurisé".** L'objectif est être délibéré sur :

- qui peut parler à votre bot
- où bot autorisé agir
- ce que bot peut toucher

Commencez avec accès le plus petit qui fonctionne toujours, puis élargissez avec confiance croissante.

### Ce que audit vérifie (high level)

- **Accès entrant** (politiques DM, politiques groupe, allowlists) : étrangers peuvent-ils trigger bot ?
- **Rayon explosion outil** (outils elevated + rooms open) : injection prompt pourrait-elle devenir actions shell/file/network ?
- **Exposition réseau** (Gateway bind/auth, Tailscale Serve/Funnel, tokens auth faibles/courts).
- **Exposition contrôle browser** (nœuds remote, ports relay, endpoints CDP remote).
- **Hygiène disque local** (permissions, symlinks, includes config, chemins "synced folder").
- **Plugins** (extensions existent sans allowlist explicite).
- **Dérive politique/misconfig** (paramètres sandbox docker configurés mais mode sandbox off ; patterns `gateway.nodes.denyCommands` inefficaces).
- **Hygiène modèle** (warn quand modèles configurés semblent legacy ; pas bloc dur).

Si vous exécutez `--deep`, OpenClaw tente aussi probe Passerelle live best-effort.

## Map stockage credentials

Utilisez lors audit accès ou décision quoi backup :

- **WhatsApp** : `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Token bot Telegram** : config/env ou `channels.telegram.tokenFile`
- **Token bot Discord** : config/env (fichier token pas encore supporté)
- **Tokens Slack** : config/env (`channels.slack.*`)

Voir aussi :

- [Configuration](/fr-FR/gateway/configuration)
- [Audit](/fr-FR/cli/security)
- [Permissions](/fr-FR/platforms/mac/permissions)
