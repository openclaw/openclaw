---
title: "Node.js"
summary: "Installeer en configureer Node.js voor OpenClaw — versievereisten, installatieopties en PATH-problemen oplossen"
read_when:
  - "Je moet Node.js installeren voordat je OpenClaw installeert"
  - "Je hebt OpenClaw geïnstalleerd maar `openclaw` is geen bekende opdracht"
  - "`npm install -g` mislukt met rechten- of PATH-problemen"
---

# Node.js

OpenClaw vereist **Node 22 of nieuwer**. Het [installatiescript](/install#install-methods) detecteert en installeert Node automatisch — deze pagina is bedoeld voor wanneer je Node zelf wilt instellen en wilt controleren of alles correct is aangesloten (versies, PATH, globale installaties).

## Controleer je versie

```bash
node -v
```

Als dit `v22.x.x` of hoger weergeeft, zit je goed. Als Node niet is geïnstalleerd of de versie te oud is, kies hieronder een installatiemethode.

## Node installeren

<Tabs>
  <Tab title="macOS">
    **Homebrew** (aanbevolen):

    ````
    ```bash
    brew install node
    ```
    
    Of download het macOS-installatieprogramma van [nodejs.org](https://nodejs.org/).
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
    
    Of gebruik een versiebeheerder (zie hieronder).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (aanbevolen):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Of download het Windows-installatieprogramma van [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Versiebeheerders maken het eenvoudig om tussen Node-versies te wisselen. Populaire opties:

- [**fnm**](https://github.com/Schniz/fnm) — snel, cross‑platform
- [**nvm**](https://github.com/nvm-sh/nvm) — veelgebruikt op macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby, enz.)

Voorbeeld met fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Zorg ervoor dat je versiebeheerder is geïnitialiseerd in het opstartbestand van je shell (`~/.zshrc` of `~/.bashrc`). Als dat niet zo is, wordt `openclaw` mogelijk niet gevonden in nieuwe terminalsessies omdat de PATH de bin-map van Node niet bevat.
  </Warning>
</Accordion>

## Problemen oplossen

### `openclaw: command not found`

Dit betekent bijna altijd dat de globale bin-map van npm niet in je PATH staat.

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
    Zoek in de uitvoer naar `<npm-prefix>/bin` (macOS/Linux) of `<npm-prefix>` (Windows).
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Voeg toe aan `~/.zshrc` of `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Open daarna een nieuwe terminal (of voer `rehash` uit in zsh / `hash -r` in bash).
          </Tab>
          <Tab title="Windows">
            Voeg de uitvoer van `npm prefix -g` toe aan je systeem-PATH via Instellingen → Systeem → Omgevingsvariabelen.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Rechtenfouten bij `npm install -g` (Linux)

Als je `EACCES`-fouten ziet, wijzig dan de globale npm-prefix naar een map waarvoor de gebruiker schrijfrechten heeft:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Voeg de regel `export PATH=...` toe aan je `~/.bashrc` of `~/.zshrc` om dit permanent te maken.
