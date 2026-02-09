---
summary: "Schema de configuration des Skills et exemples"
read_when:
  - Ajout ou modification de la configuration des Skills
  - Ajustement de la liste d’autorisation fournie ou du comportement d’installation
title: "Configuration des Skills"
---

# Configuration des Skills

Toute la configuration liée aux Skills se trouve sous `skills` dans `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Champs

- `allowBundled` : liste d’autorisation facultative pour les Skills **fournis** uniquement. Lorsqu’elle est définie, seuls
  les Skills fournis figurant dans la liste sont éligibles (les Skills gérés/de l’espace de travail ne sont pas affectés).
- `load.extraDirs` : répertoires de Skills supplémentaires à analyser (priorité la plus basse).
- `load.watch` : surveiller les dossiers de Skills et actualiser l’instantané des Skills (par défaut : true).
- `load.watchDebounceMs` : temporisation (debounce) des événements du watcher de Skills en millisecondes (par défaut : 250).
- `install.preferBrew` : privilégier les installateurs brew lorsqu’ils sont disponibles (par défaut : true).
- `install.nodeManager` : préférence d’installateur Node (`npm` | `pnpm` | `yarn` | `bun`, par défaut : npm).
  Cela n’affecte que les **installations de Skills** ; l’exécution du Gateway (passerelle) doit toujours être Node
  (Bun non recommandé pour WhatsApp/Telegram).
- `entries.<skillKey>` : surcharges par Skill.

Champs par Skill :

- `enabled` : définir `false` pour désactiver un Skill même s’il est fourni/installé.
- `env` : variables d’environnement injectées pour l’exécution de l’agent (uniquement si elles ne sont pas déjà définies).
- `apiKey` : option de confort facultative pour les Skills qui déclarent une variable d’environnement principale.

## Notes

- Les clés sous `entries` correspondent par défaut au nom du Skill. Si un Skill définit
  `metadata.openclaw.skillKey`, utilisez cette clé à la place.
- Les modifications apportées aux Skills sont prises en compte au prochain tour de l’agent lorsque le watcher est activé.

### Skills en sandbox + variables d’environnement

Lorsqu’une session est **sandboxed**, les processus des Skills s’exécutent dans Docker. La sandbox
n’hérite **pas** de l’`process.env` de l’hôte.

Utilisez l’une des options suivantes :

- `agents.defaults.sandbox.docker.env` (ou par agent `agents.list[].sandbox.docker.env`)
- intégrer (« bake ») les variables d’environnement dans votre image de sandbox personnalisée

Les `env` et `skills.entries.<skill>.env/apiKey` globaux s’appliquent uniquement aux exécutions **hôte**.
