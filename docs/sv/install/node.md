---
title: "Node.js"
summary: "Installera och konfigurera Node.js för OpenClaw — versionskrav, installationsalternativ och felsökning av PATH"
read_when:
  - "Du behöver installera Node.js innan du installerar OpenClaw"
  - "Du har installerat OpenClaw men `openclaw` är ett kommando som inte hittas"
  - "`npm install -g` misslyckas med behörighets- eller PATH-problem"
---

# Node.js

OpenClaw kräver **Node 22 eller senare**. Den [installer script](/install#install-methods) kommer att upptäcka och installera Node automatiskt — denna sida är för när du vill ställa in Node själv och se till att allt är ansluten korrekt (versioner, PATH, globala installationer).

## Kontrollera din version

```bash
node -v
```

Om detta skriver ut `v22.x.x` eller högre, är du bra. Om noden inte är installerad eller versionen är för gammal, välj en installationsmetod nedan.

## Installera Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (rekommenderas):

    ````
    ```bash
    brew install node
    ```
    
    Eller ladda ner macOS-installationsprogrammet från [nodejs.org](https://nodejs.org/).
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
    
    Eller använd en versionshanterare (se nedan).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (rekommenderas):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Eller ladda ner Windows-installationsprogrammet från [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Versionshanterare låter dig växla mellan Node versioner lätt. Populära alternativ:

- [**fnm**](https://github.com/Schniz/fnm) — snabb, plattformsoberoende
- [**nvm**](https://github.com/nvm-sh/nvm) — vanligt använd på macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglott (Node, Python, Ruby, m.m.)

Exempel med fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Se till att din versionshanterare är initierad i din skalstartfil (`~/.zshrc` eller `~/.bashrc`). Om det inte är det kan `openclaw` inte hittas i nya terminalsessioner eftersom PATH inte kommer att inkludera Nodes bin katalog.
  </Warning>
</Accordion>

## Felsökning

### `openclaw: command not found`

Detta betyder nästan alltid att npm:s globala bin-katalog inte finns på din PATH.

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
    Leta efter `<npm-prefix>/bin` (macOS/Linux) eller `<npm-prefix>` (Windows) i utdata.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Lägg till i `~/.zshrc` eller `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Öppna sedan en ny terminal (eller kör `rehash` i zsh / `hash -r` i bash).
          </Tab>
          <Tab title="Windows">
            Lägg till utdata från `npm prefix -g` i din system-PATH via Inställningar → System → Miljövariabler.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Behörighetsfel på `npm install -g` (Linux)

Om du ser `EACCES`-fel, byt npm:s globala prefix till en katalog som är skrivbar för användaren:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Lägg till raden `export PATH=...` i din `~/.bashrc` eller `~/.zshrc` för att göra det permanent.
