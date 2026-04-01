# Plan-analyzer Memory

## Zones complexes du codebase

- Cron delivery pipeline : 12 gates entre job trigger et message Telegram (voir ARCHITECTURE.md §8)
- Bootstrap file system : troncation silencieuse à 20k chars, monitoring obligatoire
- Browser/Chrome : Playwright Chromium uniquement, patches CDP requis, pas de Chrome système
- Agent routing : openclaw.json bindings + AGENTS.md routing table, 2 niveaux de config

## Estimations & calibration

(à remplir — noter effort estimé vs réel pour chaque plan)

## Approches qui fonctionnent

- Pour les patches dist : identifier les fichiers via grep sur un pattern stable (ex: `password-store`, `runHeartbeatOnce`)
- Pour les modifications ARCHITECTURE.md : toujours lister les sections impactées dans le plan

## Mises à jour ARCHITECTURE.md en attente

(vide — à remplir au fil des analyses)
