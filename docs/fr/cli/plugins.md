---
summary: "Reference CLI pour `openclaw plugins` (liste, installation, activation/desactivation, diagnostic)"
read_when:
  - Vous souhaitez installer ou gerer des plugins Gateway (passerelle) en processus
  - Vous souhaitez depanner des echecs de chargement de plugins
title: "plugins"
---

# `openclaw plugins`

Gerez les plugins/extensions du Gateway (passerelle) (charges en processus).

Liens connexes :

- Systeme de plugins : [Plugins](/plugin)
- Manifeste de plugin + schema : [Plugin manifest](/plugins/manifest)
- Renforcement de la securite : [Security](/gateway/security)

## Commandes

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Les plugins fournis sont livres avec OpenClaw mais demarrent desactives. Utilisez `plugins enable` pour
les activer.

Tous les plugins doivent fournir un fichier `openclaw.plugin.json` avec un Schema JSON en ligne
(`configSchema`, meme s'il est vide). Les manifestes ou schemas manquants/invalides empechent
le chargement du plugin et font echouer la validation de la configuration.

### Installation

```bash
openclaw plugins install <path-or-spec>
```

Note de securite : traitez l'installation de plugins comme l'execution de code. Preferez des versions epinglees.

Archives prises en charge : `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Utilisez `--link` pour eviter de copier un repertoire local (ajoute a `plugins.load.paths`) :

```bash
openclaw plugins install -l ./my-plugin
```

### Mise a jour

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Les mises a jour ne s'appliquent qu'aux plugins installes depuis npm (suivis dans `plugins.installs`).
