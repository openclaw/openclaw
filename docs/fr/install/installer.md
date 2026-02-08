---
summary: "Fonctionnement des scripts d’installation (install.sh + install-cli.sh), options et automatisation"
read_when:
  - Vous souhaitez comprendre `openclaw.ai/install.sh`
  - Vous souhaitez automatiser les installations (CI / sans interface)
  - Vous souhaitez installer depuis un dépôt GitHub cloné
title: "Fonctionnement interne de l’installateur"
x-i18n:
  source_path: install/installer.md
  source_hash: 9e0a19ecb5da0a39
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:03Z
---

# Fonctionnement interne de l’installateur

OpenClaw fournit deux scripts d’installation (servis depuis `openclaw.ai`) :

- `https://openclaw.ai/install.sh` — installateur « recommandé » (installation npm globale par défaut ; peut aussi installer depuis un dépôt GitHub cloné)
- `https://openclaw.ai/install-cli.sh` — installateur CLI compatible sans droits root (installe dans un préfixe avec son propre Node)
- `https://openclaw.ai/install.ps1` — installateur Windows PowerShell (npm par défaut ; installation via git en option)

Pour voir les options et le comportement actuels, exécutez :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --help
```

Aide Windows (PowerShell) :

```powershell
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -?
```

Si l’installateur se termine mais que `openclaw` n’est pas trouvé dans un nouveau terminal, il s’agit généralement d’un problème de PATH Node/npm. Voir : [Install](/install#nodejs--npm-path-sanity).

## install.sh (recommandé)

Ce qu’il fait (vue d’ensemble) :

- Détecte l’OS (macOS / Linux / WSL).
- S’assure de la présence de Node.js **22+** (macOS via Homebrew ; Linux via NodeSource).
- Choisit la méthode d’installation :
  - `npm` (par défaut) : `npm install -g openclaw@latest`
  - `git` : cloner/construire un dépôt source et installer un script d’enrobage
- Sous Linux : évite les erreurs de permissions npm globales en basculant le préfixe npm vers `~/.npm-global` si nécessaire.
- En cas de mise à niveau d’une installation existante : exécute `openclaw doctor --non-interactive` (au mieux).
- Pour les installations via git : exécute `openclaw doctor --non-interactive` après l’installation/la mise à jour (au mieux).
- Atténue les pièges d’installation native de `sharp` en définissant par défaut `SHARP_IGNORE_GLOBAL_LIBVIPS=1` (évite de compiler contre libvips système).

Si vous _souhaitez_ que `sharp` se lie à une libvips installée globalement (ou si vous déboguez), définissez :

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL https://openclaw.ai/install.sh | bash
```

### Découvrabilité / invite « installation via git »

Si vous exécutez l’installateur **déjà à l’intérieur d’un dépôt source OpenClaw** (détecté via `package.json` + `pnpm-workspace.yaml`), il propose :

- mettre à jour et utiliser ce dépôt (`git`)
- ou migrer vers l’installation npm globale (`npm`)

Dans les contextes non interactifs (pas de TTY / `--no-prompt`), vous devez passer `--install-method git|npm` (ou définir `OPENCLAW_INSTALL_METHOD`), sinon le script se termine avec le code `2`.

### Pourquoi Git est nécessaire

Git est requis pour le chemin `--install-method git` (clonage / pull).

Pour les installations `npm`, Git n’est _généralement_ pas requis, mais certains environnements finissent quand même par en avoir besoin (par exemple lorsqu’un paquet ou une dépendance est récupéré via une URL git). L’installateur s’assure actuellement de la présence de Git afin d’éviter des surprises `spawn git ENOENT` sur des distributions fraîchement installées.

### Pourquoi npm rencontre `EACCES` sur un Linux récent

Sur certaines configurations Linux (notamment après l’installation de Node via le gestionnaire de paquets du système ou NodeSource), le préfixe global npm pointe vers un emplacement appartenant à root. Dans ce cas, `npm install -g ...` échoue avec des erreurs de permissions `EACCES` / `mkdir`.

`install.sh` atténue cela en basculant le préfixe vers :

- `~/.npm-global` (et en l’ajoutant à `PATH` dans `~/.bashrc` / `~/.zshrc` lorsque présents)

## install-cli.sh (installateur CLI sans droits root)

Ce script installe `openclaw` dans un préfixe (par défaut : `~/.openclaw`) et installe également un runtime Node dédié sous ce préfixe, afin de fonctionner sur des machines où vous ne souhaitez pas modifier le Node/npm du système.

Aide :

```bash
curl -fsSL https://openclaw.ai/install-cli.sh | bash -s -- --help
```

## install.ps1 (Windows PowerShell)

Ce qu’il fait (vue d’ensemble) :

- S’assure de la présence de Node.js **22+** (winget/Chocolatey/Scoop ou manuel).
- Choisit la méthode d’installation :
  - `npm` (par défaut) : `npm install -g openclaw@latest`
  - `git` : cloner/construire un dépôt source et installer un script d’enrobage
- Exécute `openclaw doctor --non-interactive` lors des mises à niveau et des installations via git (au mieux).

Exemples :

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex -InstallMethod git
```

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex -InstallMethod git -GitDir "C:\\openclaw"
```

Variables d’environnement :

- `OPENCLAW_INSTALL_METHOD=git|npm`
- `OPENCLAW_GIT_DIR=...`

Exigence Git :

Si vous choisissez `-InstallMethod git` et que Git est absent, l’installateur affichera le lien Git for Windows (`https://git-scm.com/download/win`) puis quittera.

Problèmes courants sous Windows :

- **npm error spawn git / ENOENT** : installez Git for Windows et rouvrez PowerShell, puis relancez l’installateur.
- **« openclaw » n’est pas reconnu** : le dossier bin global npm n’est pas dans le PATH. La plupart des systèmes utilisent
  `%AppData%\\npm`. Vous pouvez aussi exécuter `npm config get prefix` et ajouter `\\bin` au PATH, puis rouvrir PowerShell.
