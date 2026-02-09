---
title: "Node.js"
summary: "Installer et configurer Node.js pour OpenClaw — versions requises, options d'installation et dépannage PATH"
read_when:
  - "Vous devez installer Node.js avant d'installer OpenClaw"
  - "Vous avez installé OpenClaw mais `openclaw` est « commande introuvable »"
  - "Vérification de l’installation Node.js + npm : versions, PATH et installations globales"
---

# Node.js

La base d’exécution d’OpenClaw est **Node 22+**. Le [script d'installation](/install#install-methods) détectera et installera automatiquement Node — cette page est réservée lorsque vous voulez configurer Node vous-même et vous assurer que tout est bien branché (versions, PATH, installations globales).

## Vérifiez votre version

```bash
Nœud -v
```

Si cela affiche `v22.x.x` ou supérieur, vous êtes bien. Si Node n'est pas installé ou que la version est trop ancienne, choisissez une méthode d'installation ci-dessous.

## install/node.md

<Tabs>
  <Tab title="macOS">
    **Homebrew** (recommandé) :

    ```
    macOS : Homebrew (`brew install node`) ou un gestionnaire de versions
    ```

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian :**

    ````
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22. | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
    
    **Fedora / RHEL:**
    
    ```bash
    sudo dnf install nodejs
    ```
    
    Ou utilisez un gestionnaire de versions (voir ci-dessous).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (recommandé) :

    ````
    ```powershell
    winget install OpenJS.NodeJS. TS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Ou téléchargez l'installateur Windows depuis [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Les gestionnaires de versions vous permettent de basculer facilement entre les versions de Node. Options populaires :

- [**fnm**](https://github.com/Schniz/fnm) — fast, cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) — largement utilisé sur macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polygone (Node, Python, Ruby, etc.)

Exemple avec fnm :

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Si vous utilisez un gestionnaire de versions (nvm/fnm/asdf/etc), assurez‑vous qu’il est initialisé dans le shell que vous utilisez au quotidien (zsh vs bash) afin que le PATH qu’il définit soit présent lorsque vous lancez des installateurs. Si ce n'est pas le cas, `openclaw` peut ne pas être trouvé dans les nouvelles sessions de terminaux, car le PATH n'inclut pas le répertoire de corbeille de Node.
  </Warning>
</Accordion>

## Problemes courants

### Si vous pouvez exécuter `npm install -g openclaw@latest` mais voyez ensuite `openclaw: command not found`, c’est presque toujours un problème de **PATH** : le répertoire où npm place les binaires globaux n’est pas dans le PATH de votre shell.

Correctif : ajouter le répertoire global npm au PATH

<Steps>
  <Step title="Find your global npm prefix">npm prefix -g</Step>
  <Step title="Check if it's on your PATH">bash : `~/.bashrc`

    ```
    Sous Windows, ajoutez la sortie de `npm prefix -g` à votre PATH.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">zsh : `~/.zshrc`

        ```
        # macOS / Linux
        export PATH="/path/from/npm/prefix/bin:$PATH"
        ```

  </Step>
</Steps>

### Correctif : éviter `sudo npm install -g` / erreurs de permissions (Linux)

Si `npm install -g ...` échoue avec `EACCES`, basculez le préfixe global npm vers un répertoire accessible en écriture par l’utilisateur :

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Rendez persistante la ligne `export PATH=...` dans le fichier de démarrage de votre shell.
