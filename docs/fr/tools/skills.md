---
summary: "Skills : gérées vs espace de travail, règles de filtrage et câblage config/env"
read_when:
  - Ajout ou modification de skills
  - Modification des règles de filtrage ou de chargement des skills
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw utilise des dossiers de skills **compatibles [AgentSkills](https://agentskills.io)** pour apprendre à l’agent à utiliser des outils. Chaque skill est un répertoire contenant un `SKILL.md` avec un frontmatter YAML et des instructions. OpenClaw charge les **skills intégrées** ainsi que des surcharges locales optionnelles, et les filtre au chargement en fonction de l’environnement, de la configuration et de la présence de binaires.

## Emplacements et priorité

Les skills sont chargées depuis **trois** emplacements :

1. **Skills intégrées** : livrées avec l’installation (package npm ou OpenClaw.app)
2. **Skills gérées/locales** : `~/.openclaw/skills`
3. **Skills d’espace de travail** : `<workspace>/skills`

En cas de conflit de nom de skill, l’ordre de priorité est :

`<workspace>/skills` (le plus élevé) → `~/.openclaw/skills` → skills intégrées (le plus faible)

De plus, vous pouvez configurer des dossiers de skills supplémentaires (priorité la plus basse) via
`skills.load.extraDirs` dans `~/.openclaw/openclaw.json`.

## Skills par agent vs partagées

Dans des configurations **multi-agents**, chaque agent possède son propre espace de travail. Cela signifie :

- Les **skills par agent** résident dans `<workspace>/skills` pour cet agent uniquement.
- Les **skills partagées** résident dans `~/.openclaw/skills` (gérées/locales) et sont visibles
  par **tous les agents** sur la même machine.
- Des **dossiers partagés** peuvent également être ajoutés via `skills.load.extraDirs` (priorité la plus basse)
  si vous souhaitez un pack de skills commun utilisé par plusieurs agents.

Si le même nom de skill existe à plusieurs emplacements, la priorité habituelle s’applique :
l’espace de travail l’emporte, puis gérées/locales, puis intégrées.

## Plugins + skills

Les plugins peuvent livrer leurs propres skills en listant des répertoires `skills` dans
`openclaw.plugin.json` (chemins relatifs à la racine du plugin). Les skills de plugin se chargent
lorsque le plugin est activé et participent aux règles normales de priorité des skills.
Vous pouvez les filtrer via `metadata.openclaw.requires.config` sur l’entrée de configuration du plugin. Voir [Plugins](/plugin) pour la découverte/la configuration et [Tools](/tools) pour la surface d’outils que ces skills enseignent.

## ClawHub (installation + synchronisation)

ClawHub est le registre public de skills pour OpenClaw. Parcourez-le sur
https://clawhub.com. Utilisez-le pour découvrir, installer, mettre à jour et sauvegarder des skills.
Guide complet : [ClawHub](/tools/clawhub).

Flux courants :

- Installer une skill dans votre espace de travail :
  - `clawhub install <skill-slug>`
- Mettre à jour toutes les skills installées :
  - `clawhub update --all`
- Synchroniser (analyse + publication des mises à jour) :
  - `clawhub sync --all`

Par défaut, `clawhub` installe dans `./skills` sous votre répertoire de travail courant
(ou revient à l’espace de travail OpenClaw configuré). OpenClaw le prend en compte comme `<workspace>/skills`
à la prochaine session.

## Notes de sécurité

- Traitez les skills tierces comme du **code non fiable**. Lisez-les avant activation.
- Préférez des exécutions en sandbox pour des entrées non fiables et des outils risqués. Voir [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` et `skills.entries.*.apiKey` injectent des secrets dans le processus **hôte**
  pour ce tour d’agent (pas dans la sandbox). Gardez les secrets hors des prompts et des journaux.
- Pour un modèle de menaces plus large et des checklists, voir [Security](/gateway/security).

## Format (AgentSkills + compatible Pi)

`SKILL.md` doit inclure au minimum :

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notes :

- Nous suivons la spécification AgentSkills pour la structure et l’intention.
- Le parseur utilisé par l’agent embarqué ne prend en charge que des clés de frontmatter **sur une seule ligne**.
- `metadata` doit être un **objet JSON sur une seule ligne**.
- Utilisez `{baseDir}` dans les instructions pour référencer le chemin du dossier de la skill.
- Clés de frontmatter optionnelles :
  - `homepage` — URL affichée comme « Website » dans l’UI macOS des Skills (également prise en charge via `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (par défaut : `true`). Lorsque `true`, la skill est exposée comme commande slash utilisateur.
  - `disable-model-invocation` — `true|false` (par défaut : `false`). Lorsque `true`, la skill est exclue du prompt du modèle (toujours disponible via invocation utilisateur).
  - `command-dispatch` — `tool` (optionnel). Lorsqu’il est défini sur `tool`, la commande slash contourne le modèle et est dispatchée directement vers un outil.
  - `command-tool` — nom de l’outil à invoquer lorsque `command-dispatch: tool` est défini.
  - `command-arg-mode` — `raw` (par défaut). Pour le dispatch d’outil, transmet la chaîne d’arguments brute à l’outil (sans parsing central).

    L’outil est invoqué avec les paramètres :
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Filtrage (filtres au chargement)

OpenClaw **filtre les skills au chargement** à l’aide de `metadata` (JSON sur une seule ligne) :

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
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

- `always: true` — inclure toujours la skill (ignorer les autres filtres).
- `emoji` — emoji optionnel utilisé par l’UI macOS des Skills.
- `homepage` — URL optionnelle affichée comme « Website » dans l’UI macOS des Skills.
- `os` — liste optionnelle de plateformes (`darwin`, `linux`, `win32`). Si définie, la skill n’est éligible que sur ces OS.
- `requires.bins` — liste ; chacun doit exister sur `PATH`.
- `requires.anyBins` — liste ; au moins un doit exister sur `PATH`.
- `requires.env` — liste ; la variable d’environnement doit exister **ou** être fournie en configuration.
- `requires.config` — liste de chemins `openclaw.json` qui doivent être truthy.
- `primaryEnv` — nom de variable d’environnement associé à `skills.entries.<name>.apiKey`.
- `install` — tableau optionnel de spécifications d’installateur utilisées par l’UI macOS des Skills (brew/node/go/uv/download).

Note sur la sandbox :

- `requires.bins` est vérifié sur l’**hôte** au chargement de la skill.
- Si un agent est en sandbox, le binaire doit aussi exister **à l’intérieur du conteneur**.
  Installez-le via `agents.defaults.sandbox.docker.setupCommand` (ou une image personnalisée).
  `setupCommand` s’exécute une fois après la création du conteneur.
  Les installations de packages requièrent également une sortie réseau, un FS racine inscriptible et un utilisateur root dans la sandbox.
  Exemple : la skill `summarize` (`skills/summarize/SKILL.md`) nécessite la CLI `summarize`
  dans le conteneur de sandbox pour s’y exécuter.

Exemple d’installateur :

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Notes :

- Si plusieurs installateurs sont listés, la passerelle choisit **une seule** option préférée (brew quand disponible, sinon node).
- Si tous les installateurs sont `download`, OpenClaw liste chaque entrée afin que vous puissiez voir les artefacts disponibles.
- Les spécifications d’installateur peuvent inclure `os: ["darwin"|"linux"|"win32"]` pour filtrer les options par plateforme.
- Les installations Node respectent `skills.install.nodeManager` dans `openclaw.json` (par défaut : npm ; options : npm/pnpm/yarn/bun).
  Cela n’affecte que les **installations de skills** ; le runtime de la Gateway doit rester Node
  (Bun n’est pas recommandé pour WhatsApp/Telegram).
- Installations Go : si `go` est manquant et que `brew` est disponible, la passerelle installe d’abord Go via Homebrew et définit `GOBIN` sur le `bin` de Homebrew lorsque possible.
- Installations par téléchargement : `url` (requis), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (par défaut : auto lorsqu’une archive est détectée), `stripComponents`, `targetDir` (par défaut : `~/.openclaw/tools/<skillKey>`).

Si aucun `metadata.openclaw` n’est présent, la skill est toujours éligible (sauf
si désactivée en configuration ou bloquée par `skills.allowBundled` pour les skills intégrées).

## Surcharges de configuration (`~/.openclaw/openclaw.json`)

Les skills intégrées/gérées peuvent être activées/désactivées et recevoir des valeurs d’environnement :

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

Remarque : si le nom de la skill contient des tirets, mettez la clé entre guillemets (JSON5 autorise les clés entre guillemets).

Les clés de configuration correspondent par défaut au **nom de la skill**. Si une skill définit
`metadata.openclaw.skillKey`, utilisez cette clé sous `skills.entries`.

Règles :

- `enabled: false` désactive la skill même si elle est intégrée/installée.
- `env` : injectée **uniquement si** la variable n’est pas déjà définie dans le processus.
- `apiKey` : commodité pour les skills qui déclarent `metadata.openclaw.primaryEnv`.
- `config` : sac optionnel pour des champs personnalisés par skill ; les clés personnalisées doivent se trouver ici.
- `allowBundled` : liste blanche optionnelle pour les skills **intégrées** uniquement. Si définie, seules
  les skills intégrées figurant dans la liste sont éligibles (les skills gérées/espace de travail ne sont pas affectées).

## Injection d’environnement (par exécution d’agent)

Lorsqu’une exécution d’agent démarre, OpenClaw :

1. Lit les métadonnées des skills.
2. Applique toute `skills.entries.<key>.env` ou `skills.entries.<key>.apiKey` à
   `process.env`.
3. Construit le prompt système avec les skills **éligibles**.
4. Restaure l’environnement d’origine après la fin de l’exécution.

Ceci est **limité à l’exécution de l’agent**, et non à un environnement shell global.

## Instantané de session (performance)

OpenClaw capture un instantané des skills éligibles **au démarrage d’une session** et réutilise cette liste pour les tours suivants de la même session. Les modifications de skills ou de configuration prennent effet à la prochaine nouvelle session.

Les skills peuvent également se rafraîchir en cours de session lorsque le watcher de skills est activé ou lorsqu’un nouveau nœud distant éligible apparaît (voir ci-dessous). Considérez cela comme un **rechargement à chaud** : la liste rafraîchie est prise en compte au prochain tour d’agent.

## Nœuds macOS distants (Gateway Linux)

Si la Gateway (passerelle) s’exécute sous Linux mais qu’un **nœud macOS** est connecté **avec `system.run` autorisé** (les approbations Exec de sécurité ne sont pas définies sur `deny`), OpenClaw peut considérer les skills réservées à macOS comme éligibles lorsque les binaires requis sont présents sur ce nœud. L’agent doit exécuter ces skills via l’outil `nodes` (généralement `nodes.run`).

Cela repose sur le fait que le nœud rapporte son support de commandes et sur une sonde de binaire via `system.run`. Si le nœud macOS se déconnecte ultérieurement, les skills restent visibles ; les invocations peuvent échouer jusqu’à la reconnexion du nœud.

## Watcher de skills (rafraîchissement automatique)

Par défaut, OpenClaw surveille les dossiers de skills et met à jour l’instantané des skills lorsque les fichiers `SKILL.md` changent. Configurez cela sous `skills.load` :

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

## Impact sur les tokens (liste des skills)

Lorsque des skills sont éligibles, OpenClaw injecte une liste XML compacte des skills disponibles dans le prompt système (via `formatSkillsForPrompt` dans `pi-coding-agent`). Le coût est déterministe :

- **Surcharge de base (uniquement lorsqu’il y a ≥1 skill)** : 195 caractères.
- **Par skill** : 97 caractères + la longueur des valeurs `<name>`, `<description>` et `<location>` échappées en XML.

Formule (caractères) :

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notes :

- L’échappement XML étend `& < > " '` en entités (`&amp;`, `&lt;`, etc.), augmentant la longueur.
- Le nombre de tokens varie selon le tokenizer du modèle. Une estimation approximative de type OpenAI est ~4 caractères/token, donc **97 caractères ≈ 24 tokens** par skill, plus la longueur réelle de vos champs.

## Cycle de vie des skills gérées

OpenClaw livre un ensemble de base de skills comme **skills intégrées** dans le cadre de l’installation
(package npm ou OpenClaw.app). `~/.openclaw/skills` existe pour des surcharges locales
(par exemple, épingler/appliquer un correctif à une skill sans modifier la copie intégrée). Les skills d’espace de travail appartiennent à l’utilisateur et remplacent les deux en cas de conflit de nom.

## Référence de configuration

Voir [Configuration des Skills](/tools/skills-config) pour le schéma de configuration complet.

## Vous cherchez plus de skills ?

Parcourez https://clawhub.com.

---
