---
summary: "Outils de débogage : mode watch, flux bruts de modèle et traçage de fuite de raisonnement"
read_when:
  - Vous devez inspecter la sortie brute du modèle pour détecter des fuites de raisonnement
  - Vous voulez exécuter la Passerelle en mode watch pendant l'itération
  - Vous avez besoin d'un workflow de débogage répétable
title: "Débogage"
---

# Débogage

Cette page couvre les assistants de débogage pour la sortie en streaming, particulièrement quand un
fournisseur mélange le raisonnement dans le texte normal.

## Remplacements de débogage à l'exécution

Utilisez `/debug` dans le chat pour définir des remplacements de config **uniquement à l'exécution** (mémoire, pas disque).
`/debug` est désactivé par défaut ; activez-le avec `commands.debug: true`.
C'est pratique quand vous devez basculer des paramètres obscurs sans éditer `openclaw.json`.

Exemples :

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` efface tous les remplacements et retourne à la config sur disque.

## Mode watch de Passerelle

Pour une itération rapide, exécutez la passerelle sous le surveillant de fichier :

```bash
pnpm gateway:watch --force
```

Cela correspond à :

```bash
tsx watch src/entry.ts gateway --force
```

Ajoutez n'importe quel flag CLI de passerelle après `gateway:watch` et ils seront transmis
à chaque redémarrage.

## Profil dev + passerelle dev (--dev)

Utilisez le profil dev pour isoler l'état et créer une configuration sûre et jetable pour
le débogage. Il y a **deux** flags `--dev` :

- **`--dev` global (profil) :** isole l'état sous `~/.openclaw-dev` et
  définit le port de passerelle par défaut à `19001` (les ports dérivés changent avec lui).
- **`gateway --dev` : indique à la Passerelle de créer automatiquement une config +
  workspace par défaut** quand ils manquent (et saute BOOTSTRAP.md).

Flux recommandé (profil dev + bootstrap dev) :

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Si vous n'avez pas encore d'installation globale, exécutez la CLI via `pnpm openclaw ...`.

Ce que cela fait :

1. **Isolation du profil** (`--dev` global)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (navigateur/canvas s'ajustent en conséquence)

2. **Bootstrap dev** (`gateway --dev`)
   - Écrit une config minimale si manquante (`gateway.mode=local`, bind loopback).
   - Définit `agent.workspace` vers le workspace dev.
   - Définit `agent.skipBootstrap=true` (pas de BOOTSTRAP.md).
   - Remplit les fichiers du workspace s'ils manquent :
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Identité par défaut : **C3‑PO** (droïde de protocole).
   - Saute les fournisseurs de canal en mode dev (`OPENCLAW_SKIP_CHANNELS=1`).

Flux de réinitialisation (départ propre) :

```bash
pnpm gateway:dev:reset
```

Note : `--dev` est un flag de profil **global** et est consommé par certains exécuteurs.
Si vous devez l'épeler, utilisez la forme de variable d'environnement :

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` efface la config, les identifiants, les sessions et le workspace dev (en utilisant
`trash`, pas `rm`), puis recrée la configuration dev par défaut.

Conseil : si une passerelle non‑dev fonctionne déjà (launchd/systemd), arrêtez-la d'abord :

```bash
openclaw gateway stop
```

## Journalisation de flux brut (OpenClaw)

OpenClaw peut journaliser le **flux brut de l'assistant** avant tout filtrage/formatage.
C'est le meilleur moyen de voir si le raisonnement arrive sous forme de deltas de texte brut
(ou sous forme de blocs de pensée séparés).

Activez-le via CLI :

```bash
pnpm gateway:watch --force --raw-stream
```

Remplacement de chemin optionnel :

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Variables d'environnement équivalentes :

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Fichier par défaut :

`~/.openclaw/logs/raw-stream.jsonl`

## Journalisation de chunk brut (pi-mono)

Pour capturer les **chunks compatibles OpenAI bruts** avant qu'ils ne soient analysés en blocs,
pi-mono expose un journaliseur séparé :

```bash
PI_RAW_STREAM=1
```

Chemin optionnel :

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Fichier par défaut :

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Note : ceci n'est émis que par les processus utilisant le
> fournisseur `openai-completions` de pi-mono.

## Notes de sécurité

- Les journaux de flux brut peuvent inclure des prompts complets, sorties d'outils et données utilisateur.
- Gardez les journaux locaux et supprimez-les après le débogage.
- Si vous partagez des journaux, nettoyez d'abord les secrets et PII.
