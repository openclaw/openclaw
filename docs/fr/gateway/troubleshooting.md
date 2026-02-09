---
summary: "runbook de dépannage profond pour passerelle, canaux, automatisation, nœuds et navigateur"
read_when:
  - Le centre de dépannage vous a pointé ici pour un diagnostic plus approfondi
  - Vous avez besoin de sections du runbook basées sur des symptômes stables avec des commandes exactes
title: "Problemes courants"
---

# gateway/troubleshooting.md

Cette page est le runbook profond.
Commencez à [/help/troubleshooting](/help/troubleshooting) si vous voulez d'abord le flux de triage rapide.

## Échelle de commandes

Exécutez en premier, dans cet ordre:

```bash
openclaw models auth paste-token --provider anthropic
openclaw models status
```

Signaux sains attendus :

- `openclaw gateway status` montre `Runtime: running` et `RPC probe: ok`.
- `openclaw doctor` ne signale aucun problème de config/service bloquant.
- `openclaw channels status --probe`

## Aucune réponse

Si les canaux ne sont pas à la hauteur, vérifiez le routage et la politique avant de reconnecter quoi que ce soit.

```bash
# Check local status (creds, sessions, queued events)
openclaw status
# Probe the running gateway + channels (WA connect + Telegram + Discord APIs)
openclaw status --deep

# View recent connection events
openclaw logs --limit 200 | grep "connection\\|disconnect\\|logout"
```

Recherche:

- Association en attente pour les expéditeurs de DM.
- Gating de mention de groupe (`requireMention`, `mentionPatterns`).
- Discordance entre les salons/groupes autorisés.

Signatures courantes :

- `drop guild message (mention requise` → groupe message ignoré jusqu'à mention.
- `demande d'appairage` → l'expéditeur a besoin d'approbation.
- `blocked` / `allowlist` → l'expéditeur/canal a été filtré par la politique.

Liens associés :

- Raccourcis specifiques aux fournisseurs : [/channels/troubleshooting](/channels/troubleshooting)
- Voir [Streaming](/concepts/streaming).
- [/channels/groups](/channels/groups)

## Contrôle de la connectivité du tableau de bord

Lorsque l'interface utilisateur du tableau de bord/contrôle ne se connecte pas, ne valide pas les URL, le mode d'authentification et les hypothèses de contexte sécurisées.

```bash
openclaw gateway status
```

Recherche:

- Corriger l'URL de la sonde et l'URL du tableau de bord.
- Le mode d'authentification et le jeton ne correspondent pas entre le client et la passerelle.
- Utilisation HTTP lorsque l'identité du périphérique est requise.

Signatures courantes :

- `identité de périphérique requis` → contexte non sécurisé ou authentification de périphérique manquante.
- `unauthorized` / reconnect loop → jeton/mot de passe incompatible.
- `gateway connection failed :` → wrong host/port/url target.

Liens associés :

- Voir
  [Control UI](/web/control-ui#insecure-http).
- [/gateway/authentication](/gateway/authentification)
- [/gateway/remote](/gateway/remote)

## « Gateway ne demarre pas — configuration invalide »

Utilisez ceci lorsque le service est installé mais le processus ne reste pas actif.

```bash
openclaw gateway status
openclaw doctor
```

Recherche:

- `Runtime: stopped` avec des astuces de sortie.
- `Config (cli): ...` et `Config (service): ...` devraient normalement correspondre.
- Conflit de port/écouteur.

Signatures courantes :

- « Gateway start blocked: set gateway.mode=local »
- **Si `Last gateway error:` mentionne « refusing to bind … without auth »**
- `une autre instance de passerelle est déjà en train d'écouter` / `EADDRINUSE` → conflit de port.

Liens associés :

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Les messages ne declenchent pas

Si l'état du canal est connecté mais que le flux de message est mort, concentrez-vous sur la politique, les autorisations et les règles de distribution spécifiques au canal.

```bash
Executez `openclaw channels status --probe` pour des indices d’audit.
```

Recherche:

- Politique DM (`appairage`, `allowlist`, `open`, `disabled`).
- Grouper les exigences de la liste d'autorisations et de la mention
- Autorisations/portées de l'API de canal manquantes.

Signatures courantes :

- `mention required` → message ignoré par la politique de mention de groupe.
- `appairage` / traces d'approbation en attente → expéditeur n'est pas approuvé.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → problème d'auth/permissions du canal.

Liens associés :

- Docs : [Discord](/channels/discord), [Channels troubleshooting](/channels/troubleshooting).
- Voir [WhatsApp setup](/channels/whatsapp).
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Livraison cron et pulsations cardiaques

Si cron ou battements de coeur ne fonctionnaient pas ou ne livraient pas, vérifiez l'état du planificateur d'abord, puis la cible de livraison.

```bash
openclaw cron status
openclaw cron list
openclaw cron tourne --id <jobId> --limit 20
système openclaw last
openclaw logs --follow
```

Recherche:

- Cron activé et le prochain réveil présent.
- Statut de l'historique de l'exécution de la tâche (`ok`, `skipped`, `error`).
- Les raisons du saut du cœur (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Signatures courantes :

- `cron: planificateur désactivé; les tâches ne s'exécuteront pas automatiquement` → cron désactivé.
- `cron: tick du chronomètre échoué` → tick du planificateur a échoué; vérifiez les erreurs de fichier/log/runtime.
- `Heartbeat sauté` avec `reason=quiet-hours` → en dehors de la fenêtre des heures actives.
- `heartbeat: unknown accounId` → invalid account id for heartbeat delivery target.

Liens associés :

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## L'outil du noeud appairé échoue

Si un noeud est jumelé mais que les outils échouent, isoler l'état de premier plan, de permission et d'approbation.

```bash
Les nœuds openclaw statut
openclaw décrivent les approbations de --node <idOrNameOrIp>
openclaw get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Recherche:

- Noeud en ligne avec les capacités attendues.
- La permission du système d'exploitation autorise la caméra/mic/location/screen.
- Exec approbations et état de la liste d'autorisations.

Signatures courantes :

- `NODE_BACKGROUND_UNAVAILABLE` → L'application de node doit être au premier plan.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → permission d'OS manquante.
- `SYSTEM_RUN_DENIED: approbation requise` → approbation exec en attente.
- `SYSTEM_RUN_DENIED: allowlist miss` → commande bloquée par allowlist.

Liens associés :

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Le navigateur ne demarre pas (Linux)

Utilisez ceci lorsque les actions de l'outil de navigateur échouent même si la passerelle elle-même est saine.

```bash
openclaw doctor
openclaw doctor --fix
```

Recherche:

- Chemin de l'exécutable valide du navigateur.
- Accessibilité au profil CDP.
- Onglet de relais d'extension attaché pour `profile="chrome"`.

Signatures courantes :

- Si vous voyez `"Failed to start Chrome CDP on port 18800"` :
- `browser.executablePath not found` → chemin configuré est invalide.
- `Le relais de l'extension Chrome est en cours d'exécution, mais aucun onglet n'est connecté` → relais d'extension non attaché.
- `Les pièces jointes du navigateur sont activées... non joignable` → le profil attach-only n'a pas de cible accessible.

Liens associés :

- **Guide complet :** voir [browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Si vous avez mis à niveau et quelque chose a soudainement cassé

La plupart des ruptures après la mise à jour sont la dérive de configuration ou des valeurs par défaut plus strictes sont maintenant appliquées.

### 1. Le comportement d'authentification et d'URL a été modifié

```bash
openclaw config set gateway.mode remote
openclaw config set gateway.remote.url "wss://gateway.example.com"
```

Notes :

- Si vous avez defini `gateway.mode=remote`, la **CLI par defaut** pointe vers une URL distante. Le service peut toujours tourner localement, mais votre CLI peut sonder le mauvais endroit.
- Les appels explicites `--url` ne se réfèrent pas aux identifiants stockés.

Signatures courantes :

- `gateway connection failed :` → mauvaise URL cible.
- `unauthorized` → endpoint joignable mais mauvais auth.

### 2. Rails de garde de liaison et d'authentification sont plus stricts

```bash
openclaw config set gateway.mode local
```

Notes :

- Les liaisons non loopback (`lan`/`tailnet`/`custom`, ou `auto` lorsque loopback est indisponible) necessitent une authentification :
  `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- `gateway.token` est ignore ; utilisez `gateway.auth.token`.

Signatures courantes :

- Gateway bloquee sur « Starting… sans auth\` → bind+auth ne correspond pas.
- La sonde `RPC : a échoué` pendant l'exécution est en cours → passerelle vivante mais inaccessible avec l'authentification courante/url.

### 3. L'appariement et le statut de l'appareil ont changé

```bash
openclaw pairing list <channel>
```

Verifier :

- Approbation de l'appareil en attente pour le tableau de bord/nœuds.
- En attente de jumelage des approbations après changement de politique ou d'identité.

Signatures courantes :

- `identité de périphérique requis` → authentification de l'appareil non satisfaite.
- `appairage requis` → l'expéditeur/périphérique doit être approuvé.

Si la configuration du service et le temps d'exécution ne sont toujours pas en désaccord après vérification, réinstallez les métadonnées du service à partir du même répertoire de profil/état:

```bash
openclaw doctor
openclaw gateway restart
```

Liens associés :

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentification)
- [/gateway/background-process](/gateway/background-process)
