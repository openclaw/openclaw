---
summary: "Reference CLI pour `openclaw hooks` (hooks d’agent)"
read_when:
  - Vous souhaitez gerer les hooks d’agent
  - Vous souhaitez installer ou mettre a jour des hooks
title: "hooks"
---

# `openclaw hooks`

Gerer les hooks d’agent (automatisations basees sur des evenements pour des commandes comme `/new`, `/reset`, et le demarrage de la Gateway (passerelle)).

Associes :

- Hooks : [Hooks](/hooks)
- Hooks de plugin : [Plugins](/plugin#plugin-hooks)

## Lister tous les hooks

```bash
openclaw hooks list
```

Lister tous les hooks decouverts depuis les repertoires workspace, managed et bundled.

**Options :**

- `--eligible` : Afficher uniquement les hooks eligibles (exigences satisfaites)
- `--json` : Sortie au format JSON
- `-v, --verbose` : Afficher des informations detaillees, y compris les exigences manquantes

**Exemple de sortie :**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Exemple (verbeux) :**

```bash
openclaw hooks list --verbose
```

Affiche les exigences manquantes pour les hooks non eligibles.

**Exemple (JSON) :**

```bash
openclaw hooks list --json
```

Retourne un JSON structure pour un usage programmatique.

## Obtenir des informations sur un hook

```bash
openclaw hooks info <name>
```

Afficher des informations detaillees sur un hook specifique.

**Arguments :**

- `<name>` : Nom du hook (par ex., `session-memory`)

**Options :**

- `--json` : Sortie au format JSON

**Exemple :**

```bash
openclaw hooks info session-memory
```

**Sortie :**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Verifier l’eligibilite des hooks

```bash
openclaw hooks check
```

Afficher un resume de l’etat d’eligibilite des hooks (combien sont prets vs. non prets).

**Options :**

- `--json` : Sortie au format JSON

**Exemple de sortie :**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Activer un hook

```bash
openclaw hooks enable <name>
```

Activer un hook specifique en l’ajoutant a votre configuration (`~/.openclaw/config.json`).

**Remarque :** Les hooks geres par des plugins affichent `plugin:<id>` dans `openclaw hooks list` et
ne peuvent pas etre actives/desactives ici. Activez/desactivez plutot le plugin.

**Arguments :**

- `<name>` : Nom du hook (par ex., `session-memory`)

**Exemple :**

```bash
openclaw hooks enable session-memory
```

**Sortie :**

```
✓ Enabled hook: 💾 session-memory
```

**Ce que cela fait :**

- Verifie que le hook existe et est eligible
- Met a jour `hooks.internal.entries.<name>.enabled = true` dans votre configuration
- Enregistre la configuration sur le disque

**Apres l’activation :**

- Redemarrez la Gateway (passerelle) afin que les hooks soient recharges (redemarrage de l’application de la barre de menus sur macOS, ou redemarrage de votre processus de Gateway (passerelle) en dev).

## Desactiver un hook

```bash
openclaw hooks disable <name>
```

Desactiver un hook specifique en mettant a jour votre configuration.

**Arguments :**

- `<name>` : Nom du hook (par ex., `command-logger`)

**Exemple :**

```bash
openclaw hooks disable command-logger
```

**Sortie :**

```
⏸ Disabled hook: 📝 command-logger
```

**Apres la desactivation :**

- Redemarrez la Gateway (passerelle) afin que les hooks soient recharges

## Installer des hooks

```bash
openclaw hooks install <path-or-spec>
```

Installer un pack de hooks depuis un dossier/une archive locale ou npm.

**Ce que cela fait :**

- Copie le pack de hooks dans `~/.openclaw/hooks/<id>`
- Active les hooks installes dans `hooks.internal.entries.*`
- Enregistre l’installation sous `hooks.internal.installs`

**Options :**

- `-l, --link` : Lier un repertoire local au lieu de copier (l’ajoute a `hooks.internal.load.extraDirs`)

**Archives prises en charge :** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Exemples :**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## Mettre a jour des hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Mettre a jour les packs de hooks installes (installations npm uniquement).

**Options :**

- `--all` : Mettre a jour tous les packs de hooks suivis
- `--dry-run` : Afficher ce qui changerait sans ecrire

## Hooks fournis

### session-memory

Enregistre le contexte de session en memoire lorsque vous executez `/new`.

**Activer :**

```bash
openclaw hooks enable session-memory
```

**Sortie :** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Voir :** [documentation session-memory](/hooks#session-memory)

### command-logger

Journalise tous les evenements de commande dans un fichier d’audit centralise.

**Activer :**

```bash
openclaw hooks enable command-logger
```

**Sortie :** `~/.openclaw/logs/commands.log`

**Voir les logs :**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Voir :** [documentation command-logger](/hooks#command-logger)

### soul-evil

Echange le contenu `SOUL.md` injecte avec `SOUL_EVIL.md` pendant une fenetre de purge ou de maniere aleatoire.

**Activer :**

```bash
openclaw hooks enable soul-evil
```

**Voir :** [Hook SOUL Evil](/hooks/soul-evil)

### boot-md

Execute `BOOT.md` lorsque la Gateway (passerelle) demarre (apres le demarrage des canaux).

**Evenements** : `gateway:startup`

**Activer** :

```bash
openclaw hooks enable boot-md
```

**Voir :** [documentation boot-md](/hooks#boot-md)
