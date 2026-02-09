---
summary: "Outils de débogage : mode watch, flux bruts du modèle et traçage des fuites de raisonnement"
read_when:
  - Vous devez inspecter la sortie brute du modèle pour détecter des fuites de raisonnement
  - Vous souhaitez exécuter la Gateway (passerelle) en mode watch pendant vos itérations
  - Vous avez besoin d’un workflow de débogage reproductible
title: "Débogage"
---

# Débogage

Cette page couvre les aides au débogage pour la sortie en streaming, en particulier
lorsqu’un fournisseur mélange le raisonnement dans le texte normal.

## Surcharge de débogage d'exécution

Utilisez `/debug` dans le chat pour définir des remplacements de configuration **uniquement à l’exécution** (en mémoire, pas sur disque).
`/debug` est désactivé par défaut ; activez-le avec `commands.debug: true`.
C’est pratique lorsque vous devez basculer des paramètres obscurs sans modifier `openclaw.json`.

Exemples :

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` efface tous les remplacements et revient à la configuration sur disque.

## Mode watch de la Gateway (passerelle)

Pour des itérations rapides, exécutez la gateway sous le surveillant de fichiers :

```bash
pnpm gateway:watch --force
```

Ceci correspond à :

```bash
tsx watch src/entry.ts gateway --force
```

Ajoutez tous les indicateurs CLI de la gateway après `gateway:watch` et ils seront transmis
à chaque redémarrage.

## Profil dev + gateway dev (--dev)

Utilisez le profil dev pour isoler l’état et lancer une configuration sûre et jetable
pour le débogage. Il existe **deux** indicateurs `--dev` :

- **`--dev` global (profil) :** isole l’état sous `~/.openclaw-dev` et
  définit par défaut le port de la gateway à `19001` (les ports dérivés se décalent avec lui).
- **`gateway --dev` :** indique à la Gateway de créer automatiquement une configuration +
  un espace de travail par défaut s’ils sont manquants (et d’ignorer BOOTSTRAP.md).

Flux recommandé (profil dev + bootstrap dev) :

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Si vous n’avez pas encore d’installation globale, exécutez la CLI via `pnpm openclaw ...`.

Ce que cela fait :

1. **Isolation du profil** (`--dev` global)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (le navigateur/canvas se décale en conséquence)

2. **Bootstrap dev** (`gateway --dev`)
   - Écrit une configuration minimale si elle est manquante (`gateway.mode=local`, liaison loopback).
   - Définit `agent.workspace` sur l’espace de travail dev.
   - Définit `agent.skipBootstrap=true` (pas de BOOTSTRAP.md).
   - Amorce les fichiers de l’espace de travail s’ils sont manquants :
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Identité par défaut : **C3‑PO** (droïde protocolaire).
   - Ignore les fournisseurs de canaux en mode dev (`OPENCLAW_SKIP_CHANNELS=1`).

Flux de réinitialisation (nouveau départ) :

```bash
pnpm gateway:dev:reset
```

Remarque : `--dev` est un indicateur de profil **global** et est absorbé par
certains runners.
Si vous devez l’indiquer explicitement, utilisez la forme en variable d’environnement :

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` efface la configuration, les identifiants, les sessions et l’espace de travail dev
(en utilisant `trash`, pas `rm`), puis recrée la configuration dev par défaut.

Astuce : si une gateway non dev est déjà en cours d’exécution (launchd/systemd), arrêtez-la d’abord :

```bash
openclaw gateway stop
```

## Journalisation du flux brut (OpenClaw)

OpenClaw peut journaliser le **flux brut de l’assistant** avant tout filtrage/formatage.
C’est la meilleure façon de voir si le raisonnement arrive sous forme de deltas de texte brut
(ou sous forme de blocs de réflexion séparés).

Activez-le via la CLI :

```bash
pnpm gateway:watch --force --raw-stream
```

Remplacement de chemin optionnel :

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Variantes équivalentes env :

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Fichier par défaut :

`~/.openclaw/logs/raw-stream.jsonl`

## Journalisation des chunks bruts (pi-mono)

Pour capturer les **chunks bruts compatibles OpenAI** avant qu’ils ne soient analysés en blocs,
pi-mono expose un journaliseur distinct :

```bash
PI_RAW_STREAM=1
```

Chemin optionnel :

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Fichier par défaut :

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Remarque : ceci n’est émis que par les processus utilisant le fournisseur
> `openai-completions` de pi-mono.

## Notes de sécurité

- Les journaux de flux bruts peuvent inclure des invites complètes, la sortie des outils et des données utilisateur.
- Conservez les journaux en local et supprimez-les après le débogage.
- Si vous partagez des journaux, expurgez d’abord les secrets et les PII.
