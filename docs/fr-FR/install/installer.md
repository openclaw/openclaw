---
summary: "Fonctionnement des scripts d'installation (install.sh, install-cli.sh, install.ps1), options et automatisation"
read_when:
  - Vous voulez comprendre `openclaw.ai/install.sh`
  - Vous voulez automatiser les installations (CI / sans interaction)
  - Vous voulez installer depuis un dépôt GitHub cloné
title: "Mécanismes d'installation"
---

# Mécanismes d'installation

OpenClaw fournit trois scripts d'installation, servis depuis `openclaw.ai`.

| Script                             | Plateforme           | Fonction                                                                                                              |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Installe Node si nécessaire, installe OpenClaw via npm (par défaut) ou git, et peut lancer la configuration initiale. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Installe Node + OpenClaw dans un préfixe local (`~/.openclaw`). Pas besoin de root.                                   |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installe Node si nécessaire, installe OpenClaw via npm (par défaut) ou git, et peut lancer la configuration initiale. |

## Commandes rapides

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
Si l'installation réussit mais que `openclaw` n'est pas trouvé dans un nouveau terminal, consultez [Dépannage Node.js](/fr-FR/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Recommandé pour la plupart des installations interactives sur macOS/Linux/WSL.
</Tip>

### Déroulement (install.sh)

<Steps>
  <Step title="Détecter l'OS">
    Prend en charge macOS et Linux (y compris WSL). Si macOS est détecté, installe Homebrew s'il est manquant.
  </Step>
  <Step title="Assurer Node.js 22+">
    Vérifie la version de Node et installe Node 22 si nécessaire (Homebrew sur macOS, scripts de configuration NodeSource sur Linux apt/dnf/yum).
  </Step>
  <Step title="Assurer Git">
    Installe Git s'il est manquant.
  </Step>
  <Step title="Installer OpenClaw">
    - Méthode `npm` (par défaut) : installation npm globale
    - Méthode `git` : clone/mise à jour du dépôt, installation des dépendances avec pnpm, compilation, puis installation du wrapper à `~/.local/bin/openclaw`
  </Step>
  <Step title="Tâches post-installation">
    - Exécute `openclaw doctor --non-interactive` lors des mises à jour et installations git (au mieux)
    - Tente la configuration initiale quand c'est approprié (TTY disponible, configuration initiale non désactivée, et vérifications bootstrap/config réussies)
    - Définit par défaut `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Détection de dépôt source

Si exécuté dans un dépôt OpenClaw cloné (`package.json` + `pnpm-workspace.yaml`), le script propose :

- utiliser le dépôt (`git`), ou
- utiliser l'installation globale (`npm`)

Si aucun TTY n'est disponible et qu'aucune méthode d'installation n'est définie, il utilise `npm` par défaut et avertit.

Le script se termine avec le code `2` pour une sélection de méthode invalide ou des valeurs `--install-method` invalides.

### Exemples (install.sh)

<Tabs>
  <Tab title="Par défaut">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Ignorer configuration initiale">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Installation Git">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Simulation">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Référence des options">

| Option                          | Description                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| `--install-method npm\|git`     | Choisir la méthode d'installation (par défaut : `npm`). Alias : `--method` |
| `--npm`                         | Raccourci pour la méthode npm                                              |
| `--git`                         | Raccourci pour la méthode git. Alias : `--github`                          |
| `--version <version\|dist-tag>` | Version npm ou dist-tag (par défaut : `latest`)                            |
| `--beta`                        | Utiliser le dist-tag beta si disponible, sinon revenir à `latest`          |
| `--git-dir <path>`              | Répertoire de clonage (par défaut : `~/openclaw`). Alias : `--dir`         |
| `--no-git-update`               | Ignorer `git pull` pour un dépôt existant                                  |
| `--no-prompt`                   | Désactiver les invites                                                     |
| `--no-onboard`                  | Ignorer la configuration initiale                                          |
| `--onboard`                     | Activer la configuration initiale                                          |
| `--dry-run`                     | Afficher les actions sans appliquer les changements                        |
| `--verbose`                     | Activer la sortie de débogage (`set -x`, logs npm notice-level)            |
| `--help`                        | Afficher l'aide (`-h`)                                                     |

  </Accordion>

  <Accordion title="Référence des variables d'environnement">

| Variable                                    | Description                                                |
| ------------------------------------------- | ---------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | Méthode d'installation                                     |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | Version npm ou dist-tag                                    |
| `OPENCLAW_BETA=0\|1`                        | Utiliser beta si disponible                                |
| `OPENCLAW_GIT_DIR=<path>`                   | Répertoire de clonage                                      |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Basculer les mises à jour git                              |
| `OPENCLAW_NO_PROMPT=1`                      | Désactiver les invites                                     |
| `OPENCLAW_NO_ONBOARD=1`                     | Ignorer la configuration initiale                          |
| `OPENCLAW_DRY_RUN=1`                        | Mode simulation                                            |
| `OPENCLAW_VERBOSE=1`                        | Mode débogage                                              |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | Niveau de log npm                                          |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Contrôler le comportement sharp/libvips (par défaut : `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Conçu pour les environnements où vous voulez tout sous un préfixe local (par défaut `~/.openclaw`) et aucune dépendance Node système.
</Info>

### Déroulement (install-cli.sh)

<Steps>
  <Step title="Installer l'environnement Node local">
    Télécharge l'archive Node (par défaut `22.22.0`) vers `<prefix>/tools/node-v<version>` et vérifie le SHA-256.
  </Step>
  <Step title="Assurer Git">
    Si Git est manquant, tente l'installation via apt/dnf/yum sur Linux ou Homebrew sur macOS.
  </Step>
  <Step title="Installer OpenClaw sous le préfixe">
    Installe avec npm en utilisant `--prefix <prefix>`, puis écrit un wrapper vers `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Exemples (install-cli.sh)

<Tabs>
  <Tab title="Par défaut">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Préfixe et version personnalisés">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Sortie JSON pour automatisation">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Exécuter configuration initiale">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Référence des options">

| Option                 | Description                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Préfixe d'installation (par défaut : `~/.openclaw`)                                                      |
| `--version <ver>`      | Version OpenClaw ou dist-tag (par défaut : `latest`)                                                     |
| `--node-version <ver>` | Version Node (par défaut : `22.22.0`)                                                                    |
| `--json`               | Émettre des événements NDJSON                                                                            |
| `--onboard`            | Exécuter `openclaw onboard` après l'installation                                                         |
| `--no-onboard`         | Ignorer la configuration initiale (par défaut)                                                           |
| `--set-npm-prefix`     | Sur Linux, forcer le préfixe npm à `~/.npm-global` si le préfixe actuel n'est pas accessible en écriture |
| `--help`               | Afficher l'aide (`-h`)                                                                                   |

  </Accordion>

  <Accordion title="Référence des variables d'environnement">

| Variable                                    | Description                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | Préfixe d'installation                                                                                        |
| `OPENCLAW_VERSION=<ver>`                    | Version OpenClaw ou dist-tag                                                                                  |
| `OPENCLAW_NODE_VERSION=<ver>`               | Version Node                                                                                                  |
| `OPENCLAW_NO_ONBOARD=1`                     | Ignorer la configuration initiale                                                                             |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | Niveau de log npm                                                                                             |
| `OPENCLAW_GIT_DIR=<path>`                   | Chemin de recherche pour nettoyage legacy (utilisé lors de la suppression de l'ancien sous-module `Peekaboo`) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Contrôler le comportement sharp/libvips (par défaut : `1`)                                                    |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Déroulement (install.ps1)

<Steps>
  <Step title="Assurer PowerShell et environnement Windows">
    Nécessite PowerShell 5+.
  </Step>
  <Step title="Assurer Node.js 22+">
    Si manquant, tente l'installation via winget, puis Chocolatey, puis Scoop.
  </Step>
  <Step title="Installer OpenClaw">
    - Méthode `npm` (par défaut) : installation npm globale utilisant le `-Tag` sélectionné
    - Méthode `git` : clone/mise à jour du dépôt, installation/compilation avec pnpm, et installation du wrapper à `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Tâches post-installation">
    Ajoute le répertoire bin nécessaire au PATH utilisateur quand possible, puis exécute `openclaw doctor --non-interactive` lors des mises à jour et installations git (au mieux).
  </Step>
</Steps>

### Exemples (install.ps1)

<Tabs>
  <Tab title="Par défaut">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Installation Git">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Répertoire git personnalisé">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Simulation">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
  <Tab title="Trace de débogage">
    ```powershell
    # install.ps1 n'a pas encore d'option -Verbose dédiée.
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Référence des options">

| Option                    | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `-InstallMethod npm\|git` | Méthode d'installation (par défaut : `npm`)                   |
| `-Tag <tag>`              | Dist-tag npm (par défaut : `latest`)                          |
| `-GitDir <path>`          | Répertoire de clonage (par défaut : `%USERPROFILE%\openclaw`) |
| `-NoOnboard`              | Ignorer la configuration initiale                             |
| `-NoGitUpdate`            | Ignorer `git pull`                                            |
| `-DryRun`                 | Afficher les actions uniquement                               |

  </Accordion>

  <Accordion title="Référence des variables d'environnement">

| Variable                           | Description                       |
| ---------------------------------- | --------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Méthode d'installation            |
| `OPENCLAW_GIT_DIR=<path>`          | Répertoire de clonage             |
| `OPENCLAW_NO_ONBOARD=1`            | Ignorer la configuration initiale |
| `OPENCLAW_GIT_UPDATE=0`            | Désactiver git pull               |
| `OPENCLAW_DRY_RUN=1`               | Mode simulation                   |

  </Accordion>
</AccordionGroup>

<Note>
Si `-InstallMethod git` est utilisé et que Git est manquant, le script se termine et affiche le lien Git pour Windows.
</Note>

---

## CI et automatisation

Utilisez des options/variables d'env non-interactives pour des exécutions prévisibles.

<Tabs>
  <Tab title="install.sh (npm non-interactif)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (git non-interactif)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (ignorer configuration initiale)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Dépannage

<AccordionGroup>
  <Accordion title="Pourquoi Git est-il requis ?">
    Git est requis pour la méthode d'installation `git`. Pour les installations `npm`, Git est quand même vérifié/installé pour éviter les erreurs `spawn git ENOENT` quand les dépendances utilisent des URLs git.
  </Accordion>

  <Accordion title="Pourquoi npm renvoie-t-il EACCES sur Linux ?">
    Certaines configurations Linux pointent le préfixe global npm vers des chemins appartenant à root. `install.sh` peut changer le préfixe vers `~/.npm-global` et ajouter les exports PATH aux fichiers rc du shell (quand ces fichiers existent).
  </Accordion>

  <Accordion title="Problèmes sharp/libvips">
    Les scripts définissent par défaut `SHARP_IGNORE_GLOBAL_LIBVIPS=1` pour éviter que sharp ne compile contre le libvips système. Pour outrepasser :

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows : "npm error spawn git / ENOENT"'>
    Installez Git pour Windows, rouvrez PowerShell, relancez l'installateur.
  </Accordion>

  <Accordion title='Windows : "openclaw is not recognized"'>
    Exécutez `npm config get prefix`, ajoutez `\bin`, ajoutez ce répertoire au PATH utilisateur, puis rouvrez PowerShell.
  </Accordion>

  <Accordion title="Windows : comment obtenir une sortie détaillée de l'installateur">
    `install.ps1` n'expose pas actuellement d'option `-Verbose`.
    Utilisez le traçage PowerShell pour les diagnostics au niveau du script :

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="openclaw non trouvé après installation">
    Généralement un problème de PATH. Consultez [Dépannage Node.js](/fr-FR/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
