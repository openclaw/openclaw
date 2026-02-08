---
summary: "Reference CLI pour `openclaw cron` (planifier et executer des taches en arriere-plan)"
read_when:
  - Vous voulez des taches planifiees et des reveils
  - Vous depannez l'execution de cron et les journaux
title: "cron"
x-i18n:
  source_path: cli/cron.md
  source_hash: cef64f2ac4a648d4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:53Z
---

# `openclaw cron`

Gerer les taches cron pour le planificateur de la Gateway (passerelle).

Connexe :

- Taches cron : [Cron jobs](/automation/cron-jobs)

Astuce : executez `openclaw cron --help` pour l'ensemble des commandes.

Note : les taches `cron add` isolees utilisent par defaut la diffusion `--announce`. Utilisez `--no-deliver` pour conserver la sortie en interne. `--deliver` reste un alias obsolete de `--announce`.

Note : les taches ponctuelles (`--at`) sont supprimees apres succes par defaut. Utilisez `--keep-after-run` pour les conserver.

## Modifications courantes

Mettre a jour les parametres de diffusion sans modifier le message :

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Desactiver la diffusion pour une tache isolee :

```bash
openclaw cron edit <job-id> --no-deliver
```

Annoncer dans un canal specifique :

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
