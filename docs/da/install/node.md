---
title: "Node.js"
summary: "Installér og konfigurer Node.js til OpenClaw — versionskrav, installationsmuligheder og fejlfinding af PATH"
read_when:
  - "Du skal installere Node.js før installation af OpenClaw"
  - "Du har installeret OpenClaw, men `openclaw` er en kommando, der ikke blev fundet"
  - "npm install -g mislykkes med tilladelses- eller PATH-problemer"
---

# Node.js

OpenClaw kræver **Node 22 eller nyere**. The [installer script](/install#install-methods) will detect and install Node automatically — this page is for when you want to set up Node yourself and make sure everything is wired up correct (versionsions, PATH, globale installationer).

## Tjek din version

```bash
node -v
```

Hvis dette udskriver `v22.x.x` eller højere, er du god. Hvis Node ikke er installeret eller versionen er for gammel, så vælg en installationsmetode nedenfor.

## Installér Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (anbefalet):

    ````
    ```bash
    brew install node
    ```
    
    Eller download macOS-installationsprogrammet fra [nodejs.org](https://nodejs.org/).
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
    
    Eller brug en versionsmanager (se nedenfor).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (anbefalet):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Eller download Windows-installationsprogrammet fra [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Versionsadministratorer lader dig nemt skifte mellem Node-versioner. Populære valg:

- [**fnm**](https://github.com/Schniz/fnm) — hurtig, cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) — udbredt på macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby m.m.)

Eksempel med fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Sørg for, at din version manager er initialiseret i din shell opstart fil (`~/.zshrc` eller `~/.bashrc`). Hvis det ikke er 't, 'openclaw' kan ikke findes i nye terminalsessioner, fordi PATH ikke inkluderer node's bin mappe.
  </Warning>
</Accordion>

## Fejlfinding

### `openclaw: command not found`

Det betyder næsten altid, at npm’s globale bin-mappe ikke er på din PATH.

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
    Kig efter `<npm-prefix>/bin` (macOS/Linux) eller `<npm-prefix>` (Windows) i outputtet.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Tilføj til `~/.zshrc` eller `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Åbn derefter en ny terminal (eller kør `rehash` i zsh / `hash -r` i bash).
          </Tab>
          <Tab title="Windows">
            Tilføj outputtet af `npm prefix -g` til din system-PATH via Indstillinger → System → Miljøvariabler.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Tilladelsesfejl på `npm install -g` (Linux)

Hvis du ser `EACCES`-fejl, skal du skifte npm’s globale præfiks til en brugerskrivbar mappe:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Tilføj linjen `export PATH=...` til din `~/.bashrc` eller `~/.zshrc` for at gøre det permanent.
