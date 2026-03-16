---
summary: "Référence CLI pour `openclaw hooks` (hooks agent)"
read_when:
  - Vous voulez gérer les hooks agent
  - Vous voulez installer ou mettre à jour des hooks
title: "hooks"
---

# `openclaw hooks`

Gérer les hooks agent (automations pilotées par événements pour commandes comme `/new`, `/reset` et démarrage de passerelle).

Lié :

- Hooks : [Hooks](/fr-FR/automation/hooks)
- Hooks de plugin : [Plugins](/fr-FR/tools/plugin#plugin-hooks)

## Lister tous les hooks

```bash
openclaw hooks list
```

Liste tous les hooks découverts depuis espace de travail, répertoires gérés et intégrés.

**Options :**

- `--eligible` : Afficher uniquement les hooks éligibles (exigences satisfaites)
- `--json` : Sortie en JSON
- `-v, --verbose` : Afficher informations détaillées incluant exigences manquantes

**Exemple de sortie :**

```
Hooks (4/4 prêts)

Prêts :
  🚀 boot-md ✓ - Exécuter BOOT.md au démarrage de la passerelle
  📎 bootstrap-extra-files ✓ - Injecter fichiers workspace supplémentaires pendant bootstrap agent
  📝 command-logger ✓ - Journaliser tous événements de commande dans fichier audit centralisé
  💾 session-memory ✓ - Sauvegarder contexte session en mémoire quand commande /new émise
```

## Obtenir informations sur un hook

```bash
openclaw hooks info <nom>
```

Afficher informations détaillées sur un hook spécifique.

**Arguments :**

- `<nom>` : Nom du hook (par ex., `session-memory`)

**Options :**

- `--json` : Sortie en JSON

**Exemple :**

```bash
openclaw hooks info session-memory
```

## Vérifier l'éligibilité des hooks

```bash
openclaw hooks check
```

Vérifier tous les hooks pour l'éligibilité et afficher les exigences manquantes.

## Installer un hook

```bash
openclaw hooks install <nom>
```

Installer un hook depuis le catalogue intégré.

**Exemple :**

```bash
openclaw hooks install session-memory
```

## Désinstaller un hook

```bash
openclaw hooks uninstall <nom>
```

Désinstaller un hook précédemment installé.

**Exemple :**

```bash
openclaw hooks uninstall session-memory
```

## Activer/Désactiver des hooks

```bash
openclaw hooks enable <nom>
openclaw hooks disable <nom>
```

Activer ou désactiver un hook sans le désinstaller.

## Voir aussi

- [Hooks](/fr-FR/automation/hooks)
- [Configuration](/fr-FR/gateway/configuration)
- [Plugins](/fr-FR/tools/plugin)
