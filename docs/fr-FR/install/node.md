---
title: "Node.js"
summary: "Installer et configurer Node.js pour OpenClaw — exigences de version, options d'installation et dépannage du PATH"
read_when:
  - "Vous devez installer Node.js avant d'installer OpenClaw"
  - "Vous avez installé OpenClaw mais `openclaw` n'est pas trouvé"
  - "npm install -g échoue avec des problèmes de permissions ou de PATH"
---

# Node.js

OpenClaw nécessite **Node 22 ou plus récent**. Le [script d'installation](/fr-FR/install#install-methods) détectera et installera Node automatiquement — cette page est pour quand vous voulez configurer Node vous-même et vous assurer que tout est correctement configuré (versions, PATH, installations globales).

## Vérifier votre version

```bash
node -v
```

Si cela affiche `v22.x.x` ou supérieur, vous êtes prêt. Si Node n'est pas installé ou si la version est trop ancienne, choisissez une méthode d'installation ci-dessous.

## Installer Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (recommandé) :

    ```bash
    brew install node
    ```

    Ou téléchargez l'installateur macOS depuis [nodejs.org](https://nodejs.org/).

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian :**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL :**

    ```bash
    sudo dnf install nodejs
    ```

    Ou utilisez un gestionnaire de versions (voir ci-dessous).

  </Tab>
  <Tab title="Windows">
    **winget** (recommandé) :

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey :**

    ```powershell
    choco install nodejs-lts
    ```

    Ou téléchargez l'installateur Windows depuis [nodejs.org](https://nodejs.org/).

  </Tab>
</Tabs>

<Accordion title="Utiliser un gestionnaire de versions (nvm, fnm, mise, asdf)">
  Les gestionnaires de versions vous permettent de basculer facilement entre les versions de Node. Options populaires :

- [**fnm**](https://github.com/Schniz/fnm) — rapide, multiplateforme
- [**nvm**](https://github.com/nvm-sh/nvm) — largement utilisé sur macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglotte (Node, Python, Ruby, etc.)

Exemple avec fnm :

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Assurez-vous que votre gestionnaire de versions est initialisé dans votre fichier de démarrage shell (`~/.zshrc` ou `~/.bashrc`). Sinon, `openclaw` peut ne pas être trouvé dans les nouvelles sessions de terminal car le PATH n'inclura pas le répertoire bin de Node.
  </Warning>
</Accordion>

## Dépannage

### `openclaw: command not found`

Cela signifie presque toujours que le répertoire bin global de npm n'est pas dans votre PATH.

<Steps>
  <Step title="Trouver votre préfixe npm global">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Vérifier s'il est dans votre PATH">
    ```bash
    echo "$PATH"
    ```

    Recherchez `<npm-prefix>/bin` (macOS/Linux) ou `<npm-prefix>` (Windows) dans la sortie.

  </Step>
  <Step title="Ajouter à votre fichier de démarrage shell">
    <Tabs>
      <Tab title="macOS / Linux">
        Ajoutez à `~/.zshrc` ou `~/.bashrc` :

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        Puis ouvrez un nouveau terminal (ou exécutez `rehash` dans zsh / `hash -r` dans bash).
      </Tab>
      <Tab title="Windows">
        Ajoutez la sortie de `npm prefix -g` à votre PATH système via Paramètres → Système → Variables d'environnement.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### Erreurs de permission sur `npm install -g` (Linux)

Si vous voyez des erreurs `EACCES`, basculez le préfixe global de npm vers un répertoire accessible en écriture par l'utilisateur :

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Ajoutez la ligne `export PATH=...` à votre `~/.bashrc` ou `~/.zshrc` pour la rendre permanente.
