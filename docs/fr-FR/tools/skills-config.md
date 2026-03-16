---
summary: "Schéma et exemples config skills"
read_when:
  - Ajout ou modification config skills
  - Ajustement allowlist bundled ou comportement install
title: "Config Skills"
---

# Config Skills

Toute configuration liée skills vit sous `skills` dans `~/.openclaw/openclaw.json`.

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
      nodeManager: "npm", // npm | pnpm | yarn | bun (Runtime passerelle toujours Node; bun non recommandé)
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

- `allowBundled` : allowlist optionnel pour skills **bundled** seulement. Quand défini, seulement skills bundled dans liste éligibles (skills managed/workspace non affectés).
- `load.extraDirs` : répertoires skill additionnels à scanner (précédence lowest).
- `load.watch` : watch dossiers skill et refresh snapshot skills (défaut : true).
- `load.watchDebounceMs` : debounce pour événements watcher skill en millisecondes (défaut : 250).
- `install.preferBrew` : préférer installers brew quand disponibles (défaut : true).
- `install.nodeManager` : préférence installer node (`npm` | `pnpm` | `yarn` | `bun`, défaut : npm).
  Ceci affecte seulement **installs skill** ; runtime Passerelle devrait toujours être Node (Bun non recommandé pour WhatsApp/Telegram).
- `entries.<skillKey>` : overrides per-skill.

Champs per-skill :

- `enabled` : définir `false` pour désactiver skill même si bundled/installé.
- `env` : variables environnement injectées pour run agent (seulement si pas déjà définies).
- `apiKey` : commodité optionnelle pour skills déclarant var env primaire.

## Notes

- Clés sous `entries` mappent vers nom skill par défaut. Si skill définit `metadata.openclaw.skillKey`, utilisez cette clé plutôt.
- Changements vers skills récupérés au prochain turn agent quand watcher activé.

### Skills sandboxed + vars env

Quand session **sandboxed**, processus skill tournent dans Docker. Sandbox n'hérite **pas** `process.env` host.

Utilisez un de :

- `agents.defaults.sandbox.docker.env` (ou per-agent `agents.list[].sandbox.docker.env`)
- bake env dans votre image sandbox custom

`env` global et `skills.entries.<skill>.env/apiKey` s'appliquent aux runs **host** seulement.

## Exemples

### Allowlist skills bundled

```json5
{
  skills: {
    allowBundled: ["peekaboo", "gemini"],
    // Seulement peekaboo et gemini peuvent charger depuis bundled
    // Skills managed/workspace pas affectés
  },
}
```

### Répertoires extra

```json5
{
  skills: {
    load: {
      extraDirs: ["~/Projects/custom-skills", "/opt/company-skills"],
    },
  },
}
```

### Configuration per-skill

```json5
{
  skills: {
    entries: {
      gemini: {
        enabled: true,
        apiKey: "GEMINI_API_KEY_VALUE",
        env: {
          GEMINI_MODEL: "gemini-pro",
        },
      },
      peekaboo: {
        enabled: false, // Désactivé temporairement
      },
    },
  },
}
```

### Install preferences

```json5
{
  skills: {
    install: {
      preferBrew: true, // Préférer brew pour binaires
      nodeManager: "pnpm", // Utiliser pnpm pour deps Node
    },
  },
}
```

### Sandbox avec skills

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        docker: {
          env: {
            GEMINI_API_KEY: "${GEMINI_API_KEY}", // Depuis host env
            CUSTOM_VAR: "value",
          },
        },
      },
    },
  },
  skills: {
    entries: {
      gemini: {
        enabled: true,
        // apiKey/env définis ici s'appliquent seulement runs NON-sandboxed
      },
    },
  },
}
```

## Commandes

**Lister skills disponibles :**

```bash
openclaw skills list
```

**Installer skill :**

```bash
openclaw skills install <skill-name>
```

**Activer/désactiver skill :**

```bash
openclaw config set skills.entries.<skill-name>.enabled true
openclaw config set skills.entries.<skill-name>.enabled false
```

**Recharger skills :**

```bash
# Rechargement automatique si watch activé
# Sinon, redémarrer passerelle
openclaw gateway restart
```

## Priorité chargement

Skills chargés dans ordre (precedence highest first) :

1. **Workspace skills** : `<workspace>/skills/`
2. **Managed skills** : `~/.openclaw/skills/`
3. **Bundled skills** : `<openclaw-install>/skills/`
4. **Extra dirs** : répertoires dans `skills.load.extraDirs`

Si skill même nom existe dans lieux multiples, version précédence highest gagne.

## Dépannage

**Skill pas chargé :**

```bash
# Vérifier skills détectés
openclaw skills list

# Vérifier enabled
openclaw config get skills.entries.<skill-name>.enabled

# Vérifier logs
tail -f ~/.openclaw/logs/gateway.log
```

**Vars env pas passées :**

```bash
# Vérifier config sandbox
openclaw config get agents.defaults.sandbox.docker.env

# Pour runs non-sandboxed, vérifier
openclaw config get skills.entries.<skill-name>.env
```

**Watcher pas marche :**

```bash
# Vérifier watch activé
openclaw config get skills.load.watch

# Redémarrer gateway pour forcer reload
openclaw gateway restart
```

Voir aussi :

- [Créer Skills](/fr-FR/tools/creating-skills)
- [Skills](/fr-FR/tools/skills)
- [Sandboxing](/fr-FR/gateway/sandboxing)
