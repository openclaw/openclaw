---
title: "Node.js"
summary: "Installér og konfigurer Node.js til OpenClaw — versionskrav, installationsmuligheder og fejlfinding af PATH"
read_when:
  - "Du skal installere Node.js før installation af OpenClaw"
  - "Du har installeret OpenClaw, men `openclaw` er en kommando, der ikke blev fundet"
  - "npm install -g mislykkes med tilladelses- eller PATH-problemer"
x-i18n:
  source_path: install/node.md
  source_hash: f848d6473a183090
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:22Z
---

# Node.js

OpenClaw kræver **Node 22 eller nyere**. [Installationsscriptet](/install#install-methods) registrerer og installerer Node automatisk — denne side er til, når du selv vil sætte Node op og sikre, at alt er korrekt forbundet (versioner, PATH, globale installationer).

## Tjek din version

```bash
node -v
```

Hvis dette udskriver `v22.x.x` eller højere, er du klar. Hvis Node ikke er installeret, eller versionen er for gammel, skal du vælge en installationsmetode nedenfor.

## Installér Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (anbefalet):

    ```bash
    brew install node
    ```

    Eller download macOS-installationsprogrammet fra [nodejs.org](https://nodejs.org/).

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    Eller brug en versionsmanager (se nedenfor).

  </Tab>
  <Tab title="Windows">
    **winget** (anbefalet):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    Eller download Windows-installationsprogrammet fra [nodejs.org](https://nodejs.org/).

  </Tab>
</Tabs>

<Accordion title="Brug af en versionsmanager (nvm, fnm, mise, asdf)">
  Versionsmanagere gør det nemt at skifte mellem Node-versioner. Populære muligheder:

- [**fnm**](https://github.com/Schniz/fnm) — hurtig, cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) — udbredt på macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby m.m.)

Eksempel med fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Sørg for, at din versionsmanager initialiseres i din shell-startfil (`~/.zshrc` eller `~/.bashrc`). Hvis den ikke er det, kan `openclaw` muligvis ikke findes i nye terminalsessioner, fordi PATH ikke inkluderer Nodes bin-mappe.
  </Warning>
</Accordion>

## Fejlfinding

### `openclaw: command not found`

Det betyder næsten altid, at npm’s globale bin-mappe ikke er på din PATH.

<Steps>
  <Step title="Find dit globale npm-præfiks">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Tjek om det er på din PATH">
    ```bash
    echo "$PATH"
    ```

    Kig efter `<npm-prefix>/bin` (macOS/Linux) eller `<npm-prefix>` (Windows) i outputtet.

  </Step>
  <Step title="Tilføj det til din shell-startfil">
    <Tabs>
      <Tab title="macOS / Linux">
        Tilføj til `~/.zshrc` eller `~/.bashrc`:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        Åbn derefter en ny terminal (eller kør `rehash` i zsh / `hash -r` i bash).
      </Tab>
      <Tab title="Windows">
        Tilføj outputtet af `npm prefix -g` til din system-PATH via Indstillinger → System → Miljøvariabler.
      </Tab>
    </Tabs>

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
