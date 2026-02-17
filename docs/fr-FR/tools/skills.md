---
summary: "Compétences : gérées vs workspace, règles gating et câblage config/env"
read_when:
  - Ajout ou modification compétences
  - Changement gating compétences ou règles chargement
title: "Compétences"
---

# Compétences (OpenClaw)

OpenClaw utilise des dossiers de compétences compatibles **[AgentSkills](https://agentskills.io)** pour enseigner à l'agent comment utiliser les outils. Chaque compétence est un répertoire contenant un `SKILL.md` avec frontmatter YAML et instructions. OpenClaw charge les **compétences intégrées** plus les remplacements locaux optionnels, et les filtre au chargement selon l'environnement, la config et la présence binaire.

## Emplacements et précédence

Les compétences sont chargées depuis **trois** endroits :

1. **Compétences intégrées** : fournies avec l'installation (package npm ou OpenClaw.app)
2. **Compétences gérées/locales** : `~/.openclaw/skills`
3. **Compétences workspace** : `<workspace>/skills`

Si un nom de compétence entre en conflit, la précédence est :

`<workspace>/skills` (plus haute) → `~/.openclaw/skills` → compétences intégrées (plus basse)

De plus, vous pouvez configurer des dossiers compétences supplémentaires (précédence la plus basse) via `skills.load.extraDirs` dans `~/.openclaw/openclaw.json`.

## Compétences par agent vs partagées

Dans les configurations **multi-agents**, chaque agent a son propre workspace. Cela signifie :

- Les **compétences par agent** vivent dans `<workspace>/skills` pour cet agent uniquement.
- Les **compétences partagées** vivent dans `~/.openclaw/skills` (gérées/locales) et sont visibles par **tous les agents** sur la même machine.
- Les **dossiers partagés** peuvent aussi être ajoutés via `skills.load.extraDirs` (précédence la plus basse) si vous voulez un pack compétences commun utilisé par plusieurs agents.

Si le même nom de compétence existe dans plus d'un endroit, la précédence habituelle s'applique : workspace gagne, puis géré/local, puis intégré.

## Plugins + compétences

Les plugins peuvent fournir leurs propres compétences en listant des répertoires `skills` dans `openclaw.plugin.json` (chemins relatifs à la racine plugin). Les compétences plugin se chargent quand le plugin est activé et participent aux règles de précédence compétences normales. Vous pouvez les gater via `metadata.openclaw.requires.config` sur l'entrée config du plugin. Voir [Plugins](/fr-FR/tools/plugin) pour découverte/config et [Outils](/fr-FR/tools) pour la surface outil que ces compétences enseignent.

## ClawHub (installer + sync)

ClawHub est le registre compétences public pour OpenClaw. Parcourez sur [https://clawhub.com](https://clawhub.com). Utilisez-le pour découvrir, installer, mettre à jour et sauvegarder des compétences. Guide complet : [ClawHub](/fr-FR/tools/clawhub).

Flux courants :

- Installer une compétence dans votre workspace :
  - `clawhub install <skill-slug>`
- Mettre à jour toutes les compétences installées :
  - `clawhub update --all`
- Sync (scan + publier mises à jour) :
  - `clawhub sync --all`

Par défaut, `clawhub` installe dans `./skills` sous votre répertoire de travail actuel (ou retombe sur le workspace OpenClaw configuré). OpenClaw le récupère comme `<workspace>/skills` à la prochaine session.

## Notes de sécurité

- Traitez les compétences tierces comme **code non fiable**. Lisez-les avant activation.
- Préférez les exécutions sandboxées pour entrées non fiables et outils risqués.
- `skills.entries.*.env` et `skills.entries.*.apiKey` injectent des secrets dans le processus **hôte** pour ce tour agent (pas le sandbox). Gardez les secrets hors des prompts et journaux.
- Pour un modèle de menace plus large et checklists, voir [Sécurité](/fr-FR/gateway/security).

## Format (AgentSkills + compatible Pi)

`SKILL.md` doit inclure au moins :

```markdown
---
name: nano-banana-pro
description: Générer ou éditer images via Gemini 3 Pro Image
---
```

Notes :

- Nous suivons la spec AgentSkills pour layout/intent.
- Le parseur utilisé par l'agent embarqué supporte uniquement les clés frontmatter **sur une ligne**.
- `metadata` doit être un **objet JSON sur une ligne**.
- Utilisez `{baseDir}` dans les instructions pour référencer le chemin dossier compétence.
- Clés frontmatter optionnelles :
  - `homepage` — URL affichée comme "Site Web" dans l'UI Compétences macOS (également supporté via `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (par défaut : `true`). Quand `true`, la compétence est exposée comme commande slash utilisateur.
  - `disable-model-invocation` — `true|false` (par défaut : `false`). Quand `true`, la compétence est exclue du prompt modèle (toujours disponible via invocation utilisateur).
  - `command-dispatch` — `tool` (optionnel). Quand défini à `tool`, la commande slash contourne le modèle et dispatch directement vers un outil.
  - `command-tool` — nom outil à invoquer quand `command-dispatch: tool` est défini.
  - `command-arg-mode` — `raw` (par défaut). Pour dispatch outil, forward la chaîne args brute vers l'outil (pas de parsing core).

    L'outil est invoqué avec params :
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<nom compétence>" }`.

## Gating (filtres temps de chargement)

OpenClaw **filtre les compétences au temps de chargement** en utilisant `metadata` (JSON sur une ligne) :

```markdown
---
name: nano-banana-pro
description: Générer ou éditer images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

Champs sous `metadata.openclaw` :

- `always: true` — toujours inclure la compétence (skip autres gates).
- `emoji` — emoji optionnel utilisé par l'UI Compétences macOS.
- `homepage` — URL optionnelle affichée comme "Site Web" dans l'UI Compétences macOS.
- `os` — liste optionnelle de plateformes (`darwin`, `linux`, `win32`). Si défini, la compétence est uniquement éligible sur ces OS.
- `requires.bins` — liste ; chacun doit exister sur `PATH`.
- `requires.anyBins` — liste ; au moins un doit exister sur `PATH`.
- `requires.env` — liste ; var env doit exister **ou** être fournie dans config.
- `requires.config` — liste de chemins `openclaw.json` qui doivent être truthy.
- `primaryEnv` — nom var env associé à `skills.entries.<name>.apiKey`.
- `install` — tableau optionnel de specs installeur utilisé par l'UI Compétences macOS (brew/node/go/uv/download).

Note sur sandboxing :

- `requires.bins` est vérifié sur l'**hôte** au temps de chargement compétence.
- Si un agent est sandboxé, le binaire doit aussi exister **dans le conteneur**. Installez-le via `agents.defaults.sandbox.docker.setupCommand` (ou une image personnalisée). `setupCommand` s'exécute une fois après création conteneur. Les installations package nécessitent aussi sortie réseau, FS root inscriptible et utilisateur root dans sandbox. Exemple : la compétence `summarize` (`skills/summarize/SKILL.md`) nécessite le CLI `summarize` dans le conteneur sandbox pour s'exécuter là-bas.

## Remplacements config (`~/.openclaw/openclaw.json`)

Les compétences intégrées/gérées peuvent être basculées et fournies avec valeurs env :

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Note : si le nom compétence contient des tirets, quotez la clé (JSON5 permet clés quotées).

Les clés config correspondent au **nom compétence** par défaut. Si une compétence définit `metadata.openclaw.skillKey`, utilisez cette clé sous `skills.entries`.

Règles :

- `enabled: false` désactive la compétence même si elle est intégrée/installée.
- `env` : injecté **uniquement si** la variable n'est pas déjà définie dans le processus.
- `apiKey` : commodité pour compétences qui déclarent `metadata.openclaw.primaryEnv`.
- `config` : sac optionnel pour champs personnalisés par compétence ; clés personnalisées doivent vivre ici.
- `allowBundled` : allowlist optionnelle pour compétences **intégrées** uniquement. Si définie, seules les compétences intégrées dans la liste sont éligibles (compétences gérées/workspace non affectées).

## Injection environnement (par exécution agent)

Quand une exécution agent démarre, OpenClaw :

1. Lit métadonnées compétence.
2. Applique tout `skills.entries.<key>.env` ou `skills.entries.<key>.apiKey` à `process.env`.
3. Construit le prompt système avec compétences **éligibles**.
4. Restaure l'environnement original après fin exécution.

C'est **limité à l'exécution agent**, pas un environnement shell global.

## Snapshot session (performance)

OpenClaw snapshot les compétences éligibles **quand une session démarre** et réutilise cette liste pour tours suivants dans même session. Les changements compétences ou config prennent effet à la prochaine nouvelle session.

Les compétences peuvent aussi se rafraîchir mi-session quand le watcher compétences est activé ou quand un nouveau nœud distant éligible apparaît (voir ci-dessous). Pensez-y comme un **hot reload** : la liste rafraîchie est récupérée au prochain tour agent.

## Nœuds macOS distants (passerelle Linux)

Si la Passerelle fonctionne sur Linux mais qu'un **nœud macOS** est connecté **avec `system.run` autorisé** (sécurité Approbations Exec pas définie à `deny`), OpenClaw peut traiter les compétences macOS uniquement comme éligibles quand les binaires requis sont présents sur ce nœud. L'agent devrait exécuter ces compétences via l'outil `nodes` (typiquement `nodes.run`).

Cela repose sur le nœud rapportant son support commande et sur une sonde bin via `system.run`. Si le nœud macOS se déconnecte plus tard, les compétences restent visibles ; les invocations peuvent échouer jusqu'à reconnexion nœud.

## Watcher compétences (auto-refresh)

Par défaut, OpenClaw surveille les dossiers compétences et bump le snapshot compétences quand les fichiers `SKILL.md` changent. Configurez ceci sous `skills.load` :

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Impact jetons (liste compétences)

Quand les compétences sont éligibles, OpenClaw injecte une liste XML compacte des compétences disponibles dans le prompt système (via `formatSkillsForPrompt` dans `pi-coding-agent`). Le coût est déterministe :

- **Surcharge de base (uniquement quand ≥1 compétence) :** 195 caractères.
- **Par compétence :** 97 caractères + longueur des valeurs XML-escaped `<name>`, `<description>` et `<location>`.

Formule (caractères) :

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notes :

- L'échappement XML étend `& < > " '` en entités (`&amp;`, `&lt;`, etc.), augmentant longueur.
- Les comptes jetons varient par tokenizer modèle. Une estimation style OpenAI approximative est ~4 chars/jeton, donc **97 chars ≈ 24 jetons** par compétence plus vos longueurs champ réelles.

## Cycle de vie compétences gérées

OpenClaw fournit un ensemble baseline de compétences comme **compétences intégrées** dans l'installation (package npm ou OpenClaw.app). `~/.openclaw/skills` existe pour remplacements locaux (par exemple, épingler/patcher une compétence sans changer la copie intégrée). Les compétences workspace sont détenues utilisateur et remplacent les deux en cas de conflits nom.

## Référence config

Voir [Config Compétences](/fr-FR/tools/skills-config) pour le schéma configuration complet.

## Voir aussi

- [ClawHub](/fr-FR/tools/clawhub)
- [Plugins](/fr-FR/tools/plugin)
- [Outils](/fr-FR/tools)
