---
summary: « Installer OpenClaw (installateur recommande, installation globale ou depuis les sources) »
read_when:
  - Installation d’OpenClaw
  - Vous souhaitez installer depuis GitHub
title: « Aperçu de l’installation »
x-i18n:
  source_path: install/index.md
  source_hash: 228056bb0a2176b8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:02Z
---

# Aperçu de l’installation

Utilisez l’installateur sauf si vous avez une bonne raison de ne pas le faire. Il configure la CLI et lance la prise en main.

## Installation rapide (recommandée)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Windows (PowerShell) :

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

Prochaine etape (si vous avez ignore la prise en main) :

```bash
openclaw onboard --install-daemon
```

## Configuration requise

- **Node >=22**
- macOS, Linux ou Windows via WSL2
- `pnpm` uniquement si vous compilez depuis les sources

## Choisir votre methode d’installation

### 1) Script d’installation (recommande)

Installe `openclaw` globalement via npm et lance la prise en main.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Options de l’installateur :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --help
```

Details : [Fonctionnement interne de l’installateur](/install/installer).

Non interactif (ignorer la prise en main) :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
```

### 2) Installation globale (manuelle)

Si vous avez deja Node :

```bash
npm install -g openclaw@latest
```

Si vous avez libvips installe globalement (courant sur macOS via Homebrew) et que `sharp` n’arrive pas a s’installer, forcez les binaires precompiles :

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
```

Si vous voyez `sharp: Please add node-gyp to your dependencies`, installez soit les outils de compilation (macOS : Xcode CLT + `npm install -g node-gyp`), soit utilisez la solution `SHARP_IGNORE_GLOBAL_LIBVIPS=1` ci-dessus pour ignorer la compilation native.

Ou avec pnpm :

```bash
pnpm add -g openclaw@latest
pnpm approve-builds -g                # approve openclaw, node-llama-cpp, sharp, etc.
```

pnpm exige une approbation explicite pour les paquets avec des scripts de build. Apres la premiere installation affichant l’avertissement « Ignored build scripts », executez `pnpm approve-builds -g` et selectionnez les paquets listes.

Puis :

```bash
openclaw onboard --install-daemon
```

### 3) Depuis les sources (contributeurs/dev)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard --install-daemon
```

Astuce : si vous n’avez pas encore d’installation globale, executez les commandes du depot via `pnpm openclaw ...`.

Pour des workflows de developpement plus avances, consultez [Configuration](/start/setup).

### 4) Autres options d’installation

- Docker : [Docker](/install/docker)
- Nix : [Nix](/install/nix)
- Ansible : [Ansible](/install/ansible)
- Bun (CLI uniquement) : [Bun](/install/bun)

## Apres l’installation

- Lancer la prise en main : `openclaw onboard --install-daemon`
- Verification rapide : `openclaw doctor`
- Verifier l’etat de la Gateway (passerelle) : `openclaw status` + `openclaw health`
- Ouvrir le tableau de bord : `openclaw dashboard`

## Methode d’installation : npm vs git (installateur)

L’installateur prend en charge deux methodes :

- `npm` (par defaut) : `npm install -g openclaw@latest`
- `git` : cloner/compiler depuis GitHub et executer depuis un checkout des sources

### Options de la CLI

```bash
# Explicit npm
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm

# Install from GitHub (source checkout)
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Options courantes :

- `--install-method npm|git`
- `--git-dir <path>` (par defaut : `~/openclaw`)
- `--no-git-update` (ignorer `git pull` lors de l’utilisation d’un checkout existant)
- `--no-prompt` (desactiver les invites ; requis en CI/automatisation)
- `--dry-run` (afficher ce qui se passerait ; n’apporter aucune modification)
- `--no-onboard` (ignorer la prise en main)

### Variables d’environnement

Variables d’environnement equivalentes (utiles pour l’automatisation) :

- `OPENCLAW_INSTALL_METHOD=git|npm`
- `OPENCLAW_GIT_DIR=...`
- `OPENCLAW_GIT_UPDATE=0|1`
- `OPENCLAW_NO_PROMPT=1`
- `OPENCLAW_DRY_RUN=1`
- `OPENCLAW_NO_ONBOARD=1`
- `SHARP_IGNORE_GLOBAL_LIBVIPS=0|1` (par defaut : `1` ; evite que `sharp` compile avec libvips du systeme)

## Depannage : `openclaw` introuvable (PATH)

Diagnostic rapide :

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Si `$(npm prefix -g)/bin` (macOS/Linux) ou `$(npm prefix -g)` (Windows) **n’est pas** present dans `echo "$PATH"`, votre shell ne peut pas trouver les binaires npm globaux (y compris `openclaw`).

Correctif : ajoutez-le a votre fichier de demarrage du shell (zsh : `~/.zshrc`, bash : `~/.bashrc`) :

```bash
# macOS / Linux
export PATH="$(npm prefix -g)/bin:$PATH"
```

Sous Windows, ajoutez la sortie de `npm prefix -g` a votre PATH.

Puis ouvrez un nouveau terminal (ou `rehash` dans zsh / `hash -r` dans bash).

## Mise a jour / desinstallation

- Mises a jour : [Mise a jour](/install/updating)
- Migration vers une nouvelle machine : [Migration](/install/migrating)
- Desinstallation : [Desinstallation](/install/uninstall)
