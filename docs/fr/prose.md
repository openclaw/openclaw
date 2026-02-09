---
summary: "OpenProse : workflows .prose, commandes slash et etat dans OpenClaw"
read_when:
  - Vous souhaitez executer ou ecrire des workflows .prose
  - Vous souhaitez activer le plugin OpenProse
  - Vous devez comprendre le stockage de l'etat
title: "OpenProse"
---

# OpenProse

OpenProse est un format de workflow portable, oriente Markdown, pour orchestrer des sessions d’IA. Dans OpenClaw, il est fourni sous forme de plugin qui installe un pack de Skills OpenProse ainsi qu’une commande slash `/prose`. Les programmes vivent dans des fichiers `.prose` et peuvent lancer plusieurs sous-agents avec un controle de flux explicite.

Site officiel : https://www.prose.md

## Ce que cela permet de faire

- Recherche multi-agents + synthese avec un parallelisme explicite.
- Workflows repetables et compatibles avec des approbations (revue de code, triage d’incidents, pipelines de contenu).
- Programmes `.prose` reutilisables que vous pouvez executer sur les runtimes d’agents pris en charge.

## Installer + activer

Les plugins fournis sont desactives par defaut. Activez OpenProse :

```bash
openclaw plugins enable open-prose
```

Redemarrez la Gateway (passerelle) apres avoir active le plugin.

Checkout dev/local : `openclaw plugins install ./extensions/open-prose`

Documentation associee : [Plugins](/plugin), [Manifeste de plugin](/plugins/manifest), [Skills](/tools/skills).

## Commande slash

OpenProse enregistre `/prose` comme commande de Skill invocable par l’utilisateur. Elle route vers les instructions de la VM OpenProse et utilise les outils OpenClaw en interne.

Commandes courantes :

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Exemple : un simple fichier `.prose`

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Emplacements des fichiers

OpenProse conserve l’etat sous `.prose/` dans votre espace de travail :

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Les agents persistants au niveau utilisateur se trouvent ici :

```
~/.prose/agents/
```

## Modes d’etat

OpenProse prend en charge plusieurs backends d’etat :

- **filesystem** (par defaut) : `.prose/runs/...`
- **in-context** : transitoire, pour de petits programmes
- **sqlite** (experimental) : necessite le binaire `sqlite3`
- **postgres** (experimental) : necessite `psql` et une chaine de connexion

Remarques :

- sqlite/postgres sont optionnels et experimentaux.
- Les identifiants postgres se propagent dans les journaux des sous-agents ; utilisez une base dediee avec des privileges minimaux.

## Programmes distants

`/prose run <handle/slug>` se resout en `https://p.prose.md/<handle>/<slug>`.
Les URL directes sont recuperees telles quelles. Cela utilise l’outil `web_fetch` (ou `exec` pour POST).

## Correspondance avec le runtime OpenClaw

Les programmes OpenProse se mappent aux primitives OpenClaw :

| Concept OpenProse               | Outil OpenClaw   |
| ------------------------------- | ---------------- |
| Lancer une session / outil Task | `sessions_spawn` |
| Lecture/ecriture de fichiers    | `read` / `write` |
| Recuperation Web                | `web_fetch`      |

Si votre liste d’autorisation d’outils bloque ces outils, les programmes OpenProse echoueront. Voir la [configuration des Skills](/tools/skills-config).

## Securite + approbations

Traitez les fichiers `.prose` comme du code. Revoyez-les avant execution. Utilisez les listes d’autorisation d’outils et les portes d’approbation d’OpenClaw pour controler les effets de bord.

Pour des workflows deterministes avec approbation, comparez avec [Lobster](/tools/lobster).
