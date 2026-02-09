---
summary: "Dépanner la planification et la livraison des tâches cron et des heartbeats"
read_when:
  - Cron ne s’est pas exécuté
  - Cron s’est exécuté mais aucun message n’a été livré
  - Le heartbeat semble silencieux ou ignoré
title: "Dépannage de l’automatisation"
---

# Dépannage de l’automatisation

Utilisez cette page pour les problèmes de planification et de livraison (`cron` + `heartbeat`).

## Échelle de commandes

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Ensuite, exécutez les vérifications d’automatisation :

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron ne se déclenche pas

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Une sortie correcte ressemble à :

- `cron status` indique activé et un futur `nextWakeAtMs`.
- La tâche est activée et possède une planification/un fuseau horaire valides.
- `cron runs` affiche `ok` ou une raison explicite de saut.

Signatures courantes :

- `cron: scheduler disabled; jobs will not run automatically` → cron désactivé dans la configuration/les variables d’environnement.
- `cron: timer tick failed` → le tick du planificateur a planté ; inspectez le contexte de pile/logs environnant.
- `reason: not-due` dans la sortie d’exécution → exécution manuelle appelée sans `--force` et la tâche n’est pas encore due.

## Cron déclenché mais aucune livraison

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Une sortie correcte ressemble à :

- Le statut d’exécution est `ok`.
- Le mode/la cible de livraison sont définis pour les tâches isolées.
- La sonde de canal indique que le canal cible est connecté.

Signatures courantes :

- L’exécution a réussi mais le mode de livraison est `none` → aucun message externe n’est attendu.
- Cible de livraison manquante/invalide (`channel`/`to`) → l’exécution peut réussir en interne mais ignorer la sortie.
- Erreurs d’authentification du canal (`unauthorized`, `missing_scope`, `Forbidden`) → livraison bloquée par les identifiants/permissions du canal.

## Heartbeat supprimé ou ignoré

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Une sortie correcte ressemble à :

- Heartbeat activé avec un intervalle non nul.
- Le dernier résultat de heartbeat est `ran` (ou la raison du saut est comprise).

Signatures courantes :

- `heartbeat skipped` avec `reason=quiet-hours` → en dehors de `activeHours`.
- `requests-in-flight` → la voie principale est occupée ; heartbeat différé.
- `empty-heartbeat-file` → `HEARTBEAT.md` existe mais n’a aucun contenu exploitable.
- `alerts-disabled` → les paramètres de visibilité suppriment les messages de heartbeat sortants.

## Pièges liés au fuseau horaire et à activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Règles rapides :

- `Config path not found: agents.defaults.userTimezone` signifie que la clé n’est pas définie ; le heartbeat revient au fuseau horaire de l’hôte (ou `activeHours.timezone` s’il est défini).
- Un cron sans `--tz` utilise le fuseau horaire de l’hôte de la Gateway (passerelle).
- Le heartbeat `activeHours` utilise la résolution de fuseau horaire configurée (`user`, `local` ou un fuseau IANA explicite).
- Les horodatages ISO sans fuseau horaire sont traités comme UTC pour les planifications cron `at`.

Signatures courantes :

- Les tâches s’exécutent à une heure civile incorrecte après des changements de fuseau horaire de l’hôte.
- Le heartbeat est toujours ignoré pendant votre journée parce que `activeHours.timezone` est incorrect.

Liens connexes :

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
