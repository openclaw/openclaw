---
summary: "Flux de travail Bun (expérimental) : installation et pièges par rapport à pnpm"
read_when:
  - Vous voulez la boucle de développement locale la plus rapide (bun + watch)
  - Vous rencontrez des problèmes d’installation/de patch/de scripts de cycle de vie avec Bun
title: "Bun (Expérimental)"
---

# Bun (expérimental)

Objectif : exécuter ce dépôt avec **Bun** (optionnel, non recommandé pour WhatsApp/Telegram)
sans diverger des flux de travail pnpm.

⚠️ **Non recommandé pour l’exécution du Gateway (passerelle)** (bogues WhatsApp/Telegram). Utilisez Node en production.

## Statut

- Bun est un runtime local optionnel pour exécuter directement du TypeScript (`bun run …`, `bun --watch …`).
- `pnpm` est la valeur par défaut pour les builds et reste entièrement pris en charge (et utilisé par certains outils de documentation).
- Bun ne peut pas utiliser `pnpm-lock.yaml` et l’ignorera.

## Installation

Par défaut :

```sh
bun install
```

Remarque : `bun.lock`/`bun.lockb` sont ignorés par git, il n’y a donc pas de churn du dépôt dans un sens ou dans l’autre. Si vous voulez _aucune écriture de lockfile_ :

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Scripts de cycle de vie Bun (bloqués par défaut)

Bun peut bloquer les scripts de cycle de vie des dépendances à moins qu’ils ne soient explicitement approuvés (`bun pm untrusted` / `bun pm trust`).
Pour ce dépôt, les scripts le plus souvent bloqués ne sont pas requis :

- `@whiskeysockets/baileys` `preinstall` : vérifie Node major >= 20 (nous exécutons Node 22+).
- `protobufjs` `postinstall` : émet des avertissements concernant des schémas de version incompatibles (aucun artefact de build).

Si vous rencontrez un véritable problème d’exécution nécessitant ces scripts, approuvez-les explicitement :

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Avertissements

- Certains scripts codent toujours pnpm en dur (p. ex. `docs:build`, `ui:*`, `protocol:check`). Exécutez-les via pnpm pour le moment.
