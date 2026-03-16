---
summary: "Installer OpenClaw — script d'installation, npm/pnpm, depuis la source, Docker et plus"
read_when:
  - Vous avez besoin d'une méthode d'installation autre que le démarrage rapide
  - Vous souhaitez déployer sur une plateforme cloud
  - Vous devez mettre à jour, migrer ou désinstaller
title: "Installation"
---

# Installation

Vous avez déjà suivi [Premiers pas](/fr-FR/start/getting-started) ? Vous êtes prêt — cette page est pour les méthodes d'installation alternatives, les instructions spécifiques à la plateforme et la maintenance.

## Configuration système requise

- **[Node 22+](/fr-FR/install/node)** (le [script d'installation](#méthodes-dinstallation) l'installera s'il manque)
- macOS, Linux ou Windows
- `pnpm` uniquement si vous construisez depuis la source

<Note>
Sur Windows, nous recommandons fortement d'exécuter OpenClaw sous [WSL2](https://learn.microsoft.com/fr-fr/windows/wsl/install).
</Note>

## Méthodes d'installation

<Tip>
Le **script d'installation** est la méthode recommandée pour installer OpenClaw. Il gère la détection de Node, l'installation et l'intégration en une seule étape.
</Tip>

<AccordionGroup>
  <Accordion title="Script d'installation" icon="rocket" defaultOpen>
    Télécharge la CLI, l'installe globalement via npm et lance l'assistant d'intégration.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    C'est tout — le script gère la détection de Node, l'installation et l'intégration.

    Pour ignorer l'intégration et installer uniquement le binaire :

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    Pour tous les indicateurs, variables d'environnement et options CI/automatisation, consultez [Détails de l'installateur](/fr-FR/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Si vous avez déjà Node 22+ et préférez gérer l'installation vous-même :

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="Erreurs de build sharp ?">
          Si vous avez libvips installé globalement (courant sur macOS via Homebrew) et que `sharp` échoue, forcez les binaires préconstruits :

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Si vous voyez `sharp: Please add node-gyp to your dependencies`, installez les outils de build (macOS : Xcode CLT + `npm install -g node-gyp`) ou utilisez la variable d'environnement ci-dessus.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approuver openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm nécessite une approbation explicite pour les packages avec scripts de build. Après que la première installation affiche l'avertissement "Ignored build scripts", exécutez `pnpm approve-builds -g` et sélectionnez les packages listés.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Depuis la source" icon="github">
    Pour les contributeurs ou toute personne qui souhaite exécuter depuis un checkout local.

    <Steps>
      <Step title="Cloner et construire">
        Clonez le [dépôt OpenClaw](https://github.com/openclaw/openclaw) et construisez :

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Lier la CLI">
        Rendez la commande `openclaw` disponible globalement :

        ```bash
        pnpm link --global
        ```

        Alternativement, ignorez le lien et exécutez les commandes via `pnpm openclaw ...` depuis le dépôt.
      </Step>
      <Step title="Exécuter l'intégration">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Pour des flux de travail de développement plus approfondis, consultez [Configuration](/fr-FR/start/setup).

  </Accordion>
</AccordionGroup>

## Autres méthodes d'installation

<CardGroup cols={2}>
  <Card title="Docker" href="/fr-FR/install/docker" icon="container">
    Déploiements conteneurisés ou sans tête.
  </Card>
  <Card title="Podman" href="/fr-FR/install/podman" icon="container">
    Conteneur sans root : exécutez `setup-podman.sh` une fois, puis le script de lancement.
  </Card>
  <Card title="Nix" href="/fr-FR/install/nix" icon="snowflake">
    Installation déclarative via Nix.
  </Card>
  <Card title="Ansible" href="/fr-FR/install/ansible" icon="server">
    Provisionnement automatisé de flotte.
  </Card>
  <Card title="Bun" href="/fr-FR/install/bun" icon="zap">
    Utilisation CLI uniquement via l'environnement d'exécution Bun.
  </Card>
</CardGroup>

## Après l'installation

Vérifiez que tout fonctionne :

```bash
openclaw doctor         # vérifier les problèmes de configuration
openclaw status         # statut de la passerelle
openclaw dashboard      # ouvrir l'interface navigateur
```

Si vous avez besoin de chemins d'exécution personnalisés, utilisez :

- `OPENCLAW_HOME` pour les chemins internes basés sur le répertoire personnel
- `OPENCLAW_STATE_DIR` pour l'emplacement de l'état mutable
- `OPENCLAW_CONFIG_PATH` pour l'emplacement du fichier de configuration

Consultez [Variables d'environnement](/fr-FR/help/environment) pour la priorité et les détails complets.

## Dépannage : `openclaw` non trouvé

<Accordion title="Diagnostic et correction du PATH">
  Diagnostic rapide :

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Si `$(npm prefix -g)/bin` (macOS/Linux) ou `$(npm prefix -g)` (Windows) n'est **pas** dans votre `$PATH`, votre shell ne peut pas trouver les binaires npm globaux (y compris `openclaw`).

Correction — ajoutez-le à votre fichier de démarrage shell (`~/.zshrc` ou `~/.bashrc`) :

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Sur Windows, ajoutez la sortie de `npm prefix -g` à votre PATH.

Puis ouvrez un nouveau terminal (ou `rehash` dans zsh / `hash -r` dans bash).
</Accordion>

## Mettre à jour / désinstaller

<CardGroup cols={3}>
  <Card title="Mise à jour" href="/fr-FR/install/updating" icon="refresh-cw">
    Maintenez OpenClaw à jour.
  </Card>
  <Card title="Migration" href="/fr-FR/install/migrating" icon="arrow-right">
    Déplacer vers une nouvelle machine.
  </Card>
  <Card title="Désinstallation" href="/fr-FR/install/uninstall" icon="trash-2">
    Supprimer OpenClaw complètement.
  </Card>
</CardGroup>
