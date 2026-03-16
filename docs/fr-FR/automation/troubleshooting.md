---
summary: "Dépanner la planification et la livraison de cron et heartbeat"
read_when:
  - Cron ne s'est pas exécuté
  - Cron s'est exécuté mais aucun message n'a été livré
  - Heartbeat semble silencieux ou sauté
title: "Dépannage de l'automatisation"
---

# Dépannage de l'automatisation

Utilisez cette page pour les problèmes de planificateur et de livraison (`cron` + `heartbeat`).

## Échelle de commandes

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Ensuite, exécutez les vérifications d'automatisation :

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

Une bonne sortie ressemble à :

- `cron status` rapporte activé et un `nextWakeAtMs` futur.
- La tâche est activée et a une planification/fuseau horaire valide.
- `cron runs` montre `ok` ou une raison de saut explicite.

Signatures courantes :

- `cron: scheduler disabled; jobs will not run automatically` → cron désactivé dans config/env.
- `cron: timer tick failed` → le tick du planificateur a planté ; inspecter le contexte de pile/journal environnant.
- `reason: not-due` dans la sortie d'exécution → exécution manuelle appelée sans `--force` et tâche pas encore due.

## Cron s'est déclenché mais pas de livraison

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Une bonne sortie ressemble à :

- Le statut d'exécution est `ok`.
- Le mode/cible de livraison sont définis pour les tâches isolées.
- La sonde de canal rapporte que le canal cible est connecté.

Signatures courantes :

- L'exécution a réussi mais le mode de livraison est `none` → aucun message externe n'est attendu.
- Cible de livraison manquante/invalide (`channel`/`to`) → l'exécution peut réussir en interne mais sauter la sortie.
- Erreurs d'authentification de canal (`unauthorized`, `missing_scope`, `Forbidden`) → livraison bloquée par les identifiants/permissions du canal.

## Heartbeat supprimé ou sauté

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Une bonne sortie ressemble à :

- Heartbeat activé avec un intervalle non nul.
- Le dernier résultat de heartbeat est `ran` (ou la raison du saut est comprise).

Signatures courantes :

- `heartbeat skipped` avec `reason=quiet-hours` → en dehors des `activeHours`.
- `requests-in-flight` → voie principale occupée ; heartbeat différé.
- `empty-heartbeat-file` → `HEARTBEAT.md` existe mais n'a pas de contenu actionnable.
- `alerts-disabled` → les paramètres de visibilité suppriment les messages heartbeat sortants.

## Pièges de fuseau horaire et activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone non défini"
openclaw cron list
openclaw logs --follow
```

Règles rapides :

- `Config path not found: agents.defaults.userTimezone` signifie que la clé n'est pas définie ; heartbeat replie sur le fuseau horaire de l'hôte (ou `activeHours.timezone` si défini).
- Cron sans `--tz` utilise le fuseau horaire de l'hôte de passerelle.
- Heartbeat `activeHours` utilise la résolution de fuseau horaire configurée (`user`, `local`, ou tz IANA explicite).
- Les horodatages ISO sans fuseau horaire sont traités comme UTC pour les planifications cron `at`.

Signatures courantes :

- Les tâches s'exécutent à la mauvaise heure d'horloge murale après des changements de fuseau horaire de l'hôte.
- Heartbeat toujours sauté pendant votre journée parce que `activeHours.timezone` est incorrect.

Connexes :

- [/automation/cron-jobs](/fr-FR/automation/cron-jobs)
- [/gateway/heartbeat](/fr-FR/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/fr-FR/automation/cron-vs-heartbeat)
- [/concepts/timezone](/fr-FR/concepts/timezone)
