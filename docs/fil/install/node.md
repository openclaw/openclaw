---
title: "Node.js"
summary: "I-install at i-configure ang Node.js para sa OpenClaw — mga kinakailangan sa bersyon, mga opsyon sa pag-install, at pag-troubleshoot ng PATH"
read_when:
  - "Kailangan mong i-install ang Node.js bago i-install ang OpenClaw"
  - "Na-install mo ang OpenClaw pero `openclaw` is command not found"
  - "Nabibigo ang npm install -g dahil sa mga isyu sa permission o PATH"
---

# Node.js

Kinakailangan ng OpenClaw ang **Node 22 o mas bago**. Awtomatikong idi-detect at i-i-install ng [installer script](/install#install-methods) ang Node — ang pahinang ito ay para sa mga pagkakataong gusto mong i-set up ang Node nang manu-mano at tiyaking maayos ang lahat (mga bersyon, PATH, global installs).

## Suriin ang iyong bersyon

```bash
node -v
```

Kung magpi-print ito ng `v22.x.x` o mas mataas, ayos ka na. Kung hindi naka-install ang Node o masyadong luma ang bersyon, pumili ng isang paraan ng pag-install sa ibaba.

## I-install ang Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (inirerekomenda):

    ````
    ```bash
    brew install node
    ```
    
    O i-download ang macOS installer mula sa [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ````
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
    
    **Fedora / RHEL:**
    
    ```bash
    sudo dnf install nodejs
    ```
    
    O gumamit ng version manager (tingnan sa ibaba).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (inirerekomenda):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    O i-download ang Windows installer mula sa [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Pinapahintulutan ka ng mga version manager na madaling magpalit-palit sa pagitan ng mga bersyon ng Node. Mga sikat na opsyon:

- [**fnm**](https://github.com/Schniz/fnm) — mabilis, cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) — malawakang ginagamit sa macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby, atbp.)

Halimbawa gamit ang fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Tiyaking naka-initialize ang iyong version manager sa shell startup file (`~/.zshrc` o `~/.bashrc`). Kung hindi, maaaring hindi matagpuan ang `openclaw` sa mga bagong terminal session dahil hindi isasama ng PATH ang bin directory ng Node.
  </Warning>
</Accordion>

## Pag-troubleshoot

### `openclaw: command not found`

Halos palagi itong nangangahulugang wala sa iyong PATH ang global bin directory ng npm.

<Steps>
  <Step title="Find your global npm prefix">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Check if it's on your PATH">
    ```bash
    echo "$PATH"
    ```

    ```
    Hanapin ang `<npm-prefix>/bin` (macOS/Linux) o `<npm-prefix>` (Windows) sa output.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Idagdag sa `~/.zshrc` o `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Pagkatapos ay magbukas ng bagong terminal (o patakbuhin ang `rehash` sa zsh / `hash -r` sa bash).
          </Tab>
          <Tab title="Windows">
            Idagdag ang output ng `npm prefix -g` sa iyong system PATH sa pamamagitan ng Settings → System → Environment Variables.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Mga error sa permission sa `npm install -g` (Linux)

Kung makakakita ka ng mga error na `EACCES`, ilipat ang global prefix ng npm sa isang directory na puwedeng sulatan ng user:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Idagdag ang linyang `export PATH=...` sa iyong `~/.bashrc` o `~/.zshrc` para maging permanente.
