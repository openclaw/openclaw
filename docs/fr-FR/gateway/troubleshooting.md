---
summary: "Guide de dépannage approfondi pour la passerelle, les canaux, l'automatisation, les nœuds et le navigateur"
read_when:
  - Le hub de dépannage vous a pointé ici pour un diagnostic plus approfondi
  - Vous avez besoin de sections de runbook stables basées sur les symptômes avec des commandes exactes
title: "Dépannage"
---

# Dépannage de la passerelle

Cette page est le runbook approfondi.
Commencez à [/help/troubleshooting](/fr-FR/help/troubleshooting) si vous voulez d'abord le flux de triage rapide.

## Échelle de commandes

Exécutez-les d'abord, dans cet ordre :

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Signaux sains attendus :

- `openclaw gateway status` affiche `Runtime: running` et `RPC probe: ok`.
- `openclaw doctor` ne signale aucun problème de configuration/service bloquant.
- `openclaw channels status --probe` affiche les canaux connectés/prêts.

## Pas de réponses

Si les canaux sont actifs mais rien ne répond, vérifiez le routage et la politique avant de reconnecter quoi que ce soit.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <canal>
openclaw config get channels
openclaw logs --follow
```

Recherchez :

- Appairage en attente pour les expéditeurs DM.
- Gating de mention de groupe (`requireMention`, `mentionPatterns`).
- Incompatibilités de liste blanche canal/groupe.

Signatures courantes :

- `drop guild message (mention required` → message de groupe ignoré jusqu'à mention.
- `pairing request` → l'expéditeur a besoin d'approbation.
- `blocked` / `allowlist` → expéditeur/canal filtré par la politique.

Connexe :

- [/channels/troubleshooting](/fr-FR/channels/troubleshooting)
- [/channels/pairing](/fr-FR/channels/pairing)
- [/channels/groups](/fr-FR/channels/groups)

## Connectivité de l'UI de contrôle du dashboard

Quand le dashboard/UI de contrôle ne se connecte pas, validez l'URL, le mode d'auth et les hypothèses de contexte sécurisé.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Recherchez :

- URL de sonde correcte et URL de dashboard.
- Incompatibilité de mode d'auth/jeton entre client et passerelle.
- Utilisation HTTP où l'identité de dispositif est requise.

Signatures courantes :

- `device identity required` → contexte non sécurisé ou authentification de dispositif manquante.
- `unauthorized` / boucle de reconnexion → incompatibilité jeton/mot de passe.
- `gateway connect failed:` → mauvaise cible hôte/port/url.

Connexe :

- [/web/control-ui](/fr-FR/web/control-ui)
- [/gateway/authentication](/fr-FR/gateway/authentication)
- [/gateway/remote](/fr-FR/gateway/remote)

## Service de passerelle non en cours

Utilisez ceci quand le service est installé mais le processus ne reste pas actif.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Recherchez :

- `Runtime: stopped` avec hints de sortie.
- Incompatibilité de configuration de service (`Config (cli)` vs `Config (service)`).
- Conflits de port/listener.

Signatures courantes :

- `Gateway start blocked: set gateway.mode=local` → le mode passerelle locale n'est pas activé. Correction : définir `gateway.mode="local"` dans votre config (ou exécuter `openclaw configure`). Si vous exécutez OpenClaw via Podman en utilisant l'utilisateur `openclaw` dédié, la config se trouve à `~openclaw/.openclaw/openclaw.json`.
- `refusing to bind gateway ... without auth` → liaison non-loopback sans jeton/mot de passe.
- `another gateway instance is already listening` / `EADDRINUSE` → conflit de port.

Connexe :

- [/gateway/background-process](/fr-FR/gateway/background-process)
- [/gateway/configuration](/fr-FR/gateway/configuration)
- [/gateway/doctor](/fr-FR/gateway/doctor)

## Canal connecté, messages ne circulent pas

Si l'état du canal est connecté mais le flux de messages est mort, concentrez-vous sur la politique, les permissions et les règles de livraison spécifiques au canal.

```bash
openclaw channels status --probe
openclaw pairing list <canal>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Recherchez :

- Politique DM (`pairing`, `allowlist`, `open`, `disabled`).
- Liste blanche de groupe et exigences de mention.
- Permissions/scopes API de canal manquants.

Signatures courantes :

- `mention required` → message ignoré par la politique de mention de groupe.
- `pairing` / traces d'approbation en attente → l'expéditeur n'est pas approuvé.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → problème d'auth/permissions du canal.

Connexe :

- [/channels/troubleshooting](/fr-FR/channels/troubleshooting)
- [/channels/whatsapp](/fr-FR/channels/whatsapp)
- [/channels/telegram](/fr-FR/channels/telegram)
- [/channels/discord](/fr-FR/channels/discord)

## Livraison cron et heartbeat

Si cron ou heartbeat ne s'est pas exécuté ou n'a pas livré, vérifiez d'abord l'état du planificateur, puis la cible de livraison.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Recherchez :

- Cron activé et prochain réveil présent.
- Historique de statut d'exécution de job (`ok`, `skipped`, `error`).
- Raisons de saut heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Signatures courantes :

- `cron: scheduler disabled; jobs will not run automatically` → cron désactivé.
- `cron: timer tick failed` → tick du planificateur a échoué ; vérifiez les erreurs de fichier/journal/exécution.
- `heartbeat skipped` avec `reason=quiet-hours` → en dehors de la fenêtre d'heures actives.
- `heartbeat: unknown accountId` → id de compte invalide pour la cible de livraison heartbeat.

Connexe :

- [/automation/troubleshooting](/fr-FR/automation/troubleshooting)
- [/automation/cron-jobs](/fr-FR/automation/cron-jobs)
- [/gateway/heartbeat](/fr-FR/gateway/heartbeat)

## Nœud apparié, outil échoue

Si un nœud est apparié mais les outils échouent, isolez l'état de premier plan, de permission et d'approbation.

```bash
openclaw nodes status
openclaw nodes describe --node <idOuNomOuIp>
openclaw approvals get --node <idOuNomOuIp>
openclaw logs --follow
openclaw status
```

Recherchez :

- Nœud en ligne avec les capacités attendues.
- Autorisations OS pour caméra/micro/localisation/écran.
- Approbations exec et état de liste blanche.

Signatures courantes :

- `NODE_BACKGROUND_UNAVAILABLE` → l'application du nœud doit être au premier plan.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → permission OS manquante.
- `SYSTEM_RUN_DENIED: approval required` → approbation exec en attente.
- `SYSTEM_RUN_DENIED: allowlist miss` → commande bloquée par la liste blanche.

Connexe :

- [/nodes/troubleshooting](/fr-FR/nodes/troubleshooting)
- [/nodes/index](/fr-FR/nodes/index)
- [/tools/exec-approvals](/fr-FR/tools/exec-approvals)

## Outil navigateur échoue

Utilisez ceci quand les actions d'outil navigateur échouent même si la passerelle elle-même est saine.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Recherchez :

- Chemin d'exécutable de navigateur valide.
- Accessibilité du profil CDP.
- Attachement de l'onglet relais d'extension pour `profile="chrome"`.

Signatures courantes :

- `Failed to start Chrome CDP on port` → le processus navigateur a échoué au lancement.
- `browser.executablePath not found` → le chemin configuré est invalide.
- `Chrome extension relay is running, but no tab is connected` → relais d'extension non attaché.
- `Browser attachOnly is enabled ... not reachable` → le profil attach-only n'a pas de cible accessible.

Connexe :

- [/tools/browser-linux-troubleshooting](/fr-FR/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/fr-FR/tools/chrome-extension)
- [/tools/browser](/fr-FR/tools/browser)

## Si vous avez mis à niveau et quelque chose s'est soudainement cassé

La plupart des casses post-mise à niveau sont dues à une dérive de configuration ou des valeurs par défaut plus strictes maintenant appliquées.

### 1) Le comportement d'auth et d'override d'URL a changé

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Que vérifier :

- Si `gateway.mode=remote`, les appels CLI peuvent cibler le distant alors que votre service local va bien.
- Les appels `--url` explicites ne repassent pas aux identifiants stockés.

Signatures courantes :

- `gateway connect failed:` → mauvaise cible d'URL.
- `unauthorized` → point de terminaison accessible mais mauvaise auth.

### 2) Les garde-fous bind et auth sont plus stricts

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Que vérifier :

- Les liaisons non-loopback (`lan`, `tailnet`, `custom`) nécessitent une auth configurée.
- Les anciennes clés comme `gateway.token` ne remplacent pas `gateway.auth.token`.

Signatures courantes :

- `refusing to bind gateway ... without auth` → incompatibilité bind+auth.
- `RPC probe: failed` alors que l'exécution est en cours → passerelle vivante mais inaccessible avec l'auth/url actuelle.

### 3) L'état d'appairage et d'identité de dispositif a changé

```bash
openclaw devices list
openclaw pairing list <canal>
openclaw logs --follow
openclaw doctor
```

Que vérifier :

- Approbations de dispositif en attente pour dashboard/nœuds.
- Approbations d'appairage DM en attente après changements de politique ou d'identité.

Signatures courantes :

- `device identity required` → auth de dispositif non satisfaite.
- `pairing required` → expéditeur/dispositif doit être approuvé.

Si la configuration de service et l'exécution sont toujours en désaccord après les vérifications, réinstallez les métadonnées de service depuis le même profil/répertoire d'état :

```bash
openclaw gateway install --force
openclaw gateway restart
```

Connexe :

- [/gateway/pairing](/fr-FR/gateway/pairing)
- [/gateway/authentication](/fr-FR/gateway/authentication)
- [/gateway/background-process](/fr-FR/gateway/background-process)
