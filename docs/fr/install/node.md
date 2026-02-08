---
title: "Node.js + npm (cohérence du PATH)"
summary: "Vérification de l’installation Node.js + npm : versions, PATH et installations globales"
read_when:
  - "Vous avez installé OpenClaw mais `openclaw` est « commande introuvable »"
  - "Vous configurez Node.js/npm sur une nouvelle machine"
  - "npm install -g ... échoue avec des problèmes de permissions ou de PATH"
x-i18n:
  source_path: install/node.md
  source_hash: 9f6d83be362e3e14
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:01Z
---

# Node.js + npm (cohérence du PATH)

La base d’exécution d’OpenClaw est **Node 22+**.

Si vous pouvez exécuter `npm install -g openclaw@latest` mais voyez ensuite `openclaw: command not found`, c’est presque toujours un problème de **PATH** : le répertoire où npm place les binaires globaux n’est pas dans le PATH de votre shell.

## Diagnostic rapide

Exécutez :

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Si `$(npm prefix -g)/bin` (macOS/Linux) ou `$(npm prefix -g)` (Windows) n’est **pas** présent dans `echo "$PATH"`, votre shell ne peut pas trouver les binaires npm globaux (y compris `openclaw`).

## Correctif : ajouter le répertoire global npm au PATH

1. Trouvez le préfixe npm global :

```bash
npm prefix -g
```

2. Ajoutez le répertoire des binaires npm globaux au fichier de démarrage de votre shell :

- zsh : `~/.zshrc`
- bash : `~/.bashrc`

Exemple (remplacez le chemin par la sortie de `npm prefix -g`) :

```bash
# macOS / Linux
export PATH="/path/from/npm/prefix/bin:$PATH"
```

Puis ouvrez un **nouveau terminal** (ou exécutez `rehash` dans zsh / `hash -r` dans bash).

Sous Windows, ajoutez la sortie de `npm prefix -g` à votre PATH.

## Correctif : éviter `sudo npm install -g` / erreurs de permissions (Linux)

Si `npm install -g ...` échoue avec `EACCES`, basculez le préfixe global npm vers un répertoire accessible en écriture par l’utilisateur :

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Rendez persistante la ligne `export PATH=...` dans le fichier de démarrage de votre shell.

## Options d’installation Node recommandées

Vous aurez le moins de surprises si Node/npm sont installés d’une manière qui :

- maintient Node à jour (22+)
- rend le répertoire des binaires npm globaux stable et présent dans le PATH des nouveaux shells

Choix courants :

- macOS : Homebrew (`brew install node`) ou un gestionnaire de versions
- Linux : votre gestionnaire de versions préféré, ou une installation prise en charge par la distribution qui fournit Node 22+
- Windows : l’installateur officiel de Node, `winget`, ou un gestionnaire de versions Node pour Windows

Si vous utilisez un gestionnaire de versions (nvm/fnm/asdf/etc), assurez‑vous qu’il est initialisé dans le shell que vous utilisez au quotidien (zsh vs bash) afin que le PATH qu’il définit soit présent lorsque vous lancez des installateurs.
