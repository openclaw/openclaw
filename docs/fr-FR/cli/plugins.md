---
summary: "Référence CLI pour `openclaw plugins` (list, install, uninstall, enable/disable, doctor)"
read_when:
  - Vous voulez installer ou gérer des plugins de Passerelle en cours de processus
  - Vous voulez déboguer les échecs de chargement de plugin
title: "plugins"
---

# `openclaw plugins`

Gérer les plugins/extensions de Passerelle (chargés en cours de processus).

Connexe :

- Système de plugins : [Plugins](/fr-FR/tools/plugin)
- Manifeste + schéma de plugin : [Manifeste de plugin](/fr-FR/plugins/manifest)
- Durcissement de sécurité : [Sécurité](/fr-FR/gateway/security)

## Commandes

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Les plugins intégrés sont fournis avec OpenClaw mais démarrent désactivés. Utilisez `plugins enable` pour les activer.

Tous les plugins doivent fournir un fichier `openclaw.plugin.json` avec un schéma JSON intégré (`configSchema`, même s'il est vide). Les manifestes ou schémas manquants/invalides empêchent le chargement du plugin et font échouer la validation de config.

### Install

```bash
openclaw plugins install <path-or-spec>
```

Note de sécurité : traitez les installations de plugin comme l'exécution de code. Préférez les versions épinglées.

Les specs npm sont **registry-only** (nom de paquet + version/tag optionnel). Les specs Git/URL/file sont rejetées. Les installations de dépendances s'exécutent avec `--ignore-scripts` pour la sécurité.

Archives supportées : `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Utilisez `--link` pour éviter de copier un répertoire local (ajoute à `plugins.load.paths`) :

```bash
openclaw plugins install -l ./my-plugin
```

### Uninstall

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` supprime les enregistrements de plugin de `plugins.entries`, `plugins.installs`, la liste blanche de plugin, et les entrées `plugins.load.paths` liées quand applicable.
Pour les plugins de mémoire actifs, le slot de mémoire se réinitialise à `memory-core`.

Par défaut, uninstall supprime aussi le répertoire d'installation du plugin sous la racine des extensions du répertoire d'état actif (`$OPENCLAW_STATE_DIR/extensions/<id>`). Utilisez `--keep-files` pour conserver les fichiers sur disque.

`--keep-config` est supporté comme alias déprécié pour `--keep-files`.

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Les mises à jour s'appliquent uniquement aux plugins installés depuis npm (suivis dans `plugins.installs`).
