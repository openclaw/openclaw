---
summary: "Référence CLI pour `openclaw cron` (planifier et exécuter des tâches en arrière-plan)"
read_when:
  - Vous voulez des tâches planifiées et des réveils
  - Vous déboguez l'exécution cron et les logs
title: "cron"
---

# `openclaw cron`

Gérer les tâches cron pour le planificateur de Passerelle.

Connexe :

- Tâches cron : [Tâches cron](/fr-FR/automation/cron-jobs)

Astuce : exécutez `openclaw cron --help` pour la surface de commande complète.

Note : les tâches `cron add` isolées utilisent par défaut la livraison `--announce`. Utilisez `--no-deliver` pour garder la sortie interne. `--deliver` reste comme alias déprécié pour `--announce`.

Note : les tâches ponctuelles (`--at`) suppriment après succès par défaut. Utilisez `--keep-after-run` pour les conserver.

Note : les tâches récurrentes utilisent maintenant un backoff de retry exponentiel après erreurs consécutives (30s → 1m → 5m → 15m → 60m), puis reviennent au planning normal après la prochaine exécution réussie.

## Modifications courantes

Mettre à jour les paramètres de livraison sans changer le message :

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Désactiver la livraison pour une tâche isolée :

```bash
openclaw cron edit <job-id> --no-deliver
```

Annoncer vers un canal spécifique :

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
