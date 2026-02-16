---
summary: "OpenProse : workflows .prose, commandes slash et état dans OpenClaw"
read_when:
  - Vous voulez exécuter ou écrire des workflows .prose
  - Vous voulez activer le plugin OpenProse
  - Vous devez comprendre le stockage d'état
title: "OpenProse"
---

# OpenProse

OpenProse est un format de workflow portable, markdown-first pour orchestrer des sessions IA. Dans OpenClaw il est fourni comme un plugin qui installe un pack de compétences OpenProse plus une commande slash `/prose`. Les programmes vivent dans des fichiers `.prose` et peuvent générer plusieurs sous-agents avec flux de contrôle explicite.

Site officiel : [https://www.prose.md](https://www.prose.md)

## Ce qu'il peut faire

- Recherche + synthèse multi-agent avec parallélisme explicite.
- Workflows reproductibles sécurisés par approbation (revue de code, triage d'incident, pipelines de contenu).
- Programmes `.prose` réutilisables que vous pouvez exécuter sur les runtimes d'agent supportés.

## Installer + activer

Les plugins intégrés sont désactivés par défaut. Activez OpenProse :

```bash
openclaw plugins enable open-prose
```

Redémarrez la Passerelle après avoir activé le plugin.

Dev/checkout local : `openclaw plugins install ./extensions/open-prose`

Docs liés : [Plugins](/fr-FR/tools/plugin), [Manifeste Plugin](/fr-FR/plugins/manifest), [Compétences](/fr-FR/tools/skills).

## Commande slash

OpenProse enregistre `/prose` comme une commande de compétence invocable par l'utilisateur. Elle route vers les instructions VM OpenProse et utilise les outils OpenClaw en dessous.

Commandes communes :

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Exemple : un fichier `.prose` simple

```prose
# Recherche + synthèse avec deux agents s'exécutant en parallèle.

input topic: "Que devrions-nous rechercher ?"

agent researcher:
  model: sonnet
  prompt: "Vous recherchez minutieusement et citez les sources."

agent writer:
  model: opus
  prompt: "Vous écrivez un résumé concis."

parallel:
  findings = session: researcher
    prompt: "Recherchez {topic}."
  draft = session: writer
    prompt: "Résumez {topic}."

session "Fusionnez les découvertes + brouillon dans une réponse finale."
context: { findings, draft }
```

## Emplacements de fichiers

OpenProse garde l'état sous `.prose/` dans votre espace de travail :

```
.prose/
├── .env
├── runs/
│   └── {AAAAMMJJ}-{HHMMSS}-{aléatoire}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Les agents persistants niveau utilisateur vivent à :

```
~/.prose/agents/
```

## Modes d'état

OpenProse supporte plusieurs backends d'état :

- **filesystem** (par défaut) : `.prose/runs/...`
- **in-context** : transitoire, pour petits programmes
- **sqlite** (expérimental) : nécessite le binaire `sqlite3`
- **postgres** (expérimental) : nécessite `psql` et une chaîne de connexion

Notes :

- sqlite/postgres sont opt-in et expérimentaux.
- les identifiants postgres circulent dans les journaux de sous-agent ; utilisez une DB dédiée, moins privilégiée.

## Programmes distants

`/prose run <handle/slug>` résout vers `https://p.prose.md/<handle>/<slug>`.
Les URL directes sont récupérées telles quelles. Cela utilise l'outil `web_fetch` (ou `exec` pour POST).

## Mappage runtime OpenClaw

Les programmes OpenProse mappent vers les primitives OpenClaw :

| Concept OpenProse            | Outil OpenClaw   |
| ---------------------------- | ---------------- |
| Générer session / Outil Task | `sessions_spawn` |
| Lecture/écriture fichier     | `read` / `write` |
| Récupération web             | `web_fetch`      |

Si votre allowlist d'outil bloque ces outils, les programmes OpenProse échoueront. Voir [Config Compétences](/fr-FR/tools/skills-config).

## Sécurité + approbations

Traitez les fichiers `.prose` comme du code. Révisez avant d'exécuter. Utilisez les allowlists d'outil OpenClaw et les portes d'approbation pour contrôler les effets secondaires.

Pour des workflows déterministes, gatés par approbation, comparez avec [Lobster](/fr-FR/tools/lobster).
