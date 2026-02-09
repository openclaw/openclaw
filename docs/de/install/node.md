---
title: "Node.js"
summary: "Node.js für OpenClaw installieren und konfigurieren — Versionsanforderungen, Installationsoptionen und PATH-Fehlerbehebung"
read_when:
  - "Sie müssen Node.js installieren, bevor Sie OpenClaw installieren"
  - "Sie haben OpenClaw installiert, aber `openclaw` ist ein Befehl nicht gefunden"
  - "`npm install -g` schlägt mit Berechtigungs- oder PATH-Problemen fehl"
---

# Node.js

OpenClaw erfordert **Node 22 oder neuer**. Das [Installationsskript](/install#install-methods) erkennt und installiert Node automatisch — diese Seite ist für den Fall gedacht, dass Sie Node selbst einrichten möchten und sicherstellen wollen, dass alles korrekt verbunden ist (Versionen, PATH, globale Installationen).

## Version prüfen

```bash
node -v
```

Wenn dies `v22.x.x` oder höher ausgibt, ist alles in Ordnung. Wenn Node nicht installiert ist oder die Version zu alt ist, wählen Sie unten eine Installationsmethode.

## Node installieren

<Tabs>
  <Tab title="macOS">
    **Homebrew** (empfohlen):

    ````
    ```bash
    brew install node
    ```
    
    Oder laden Sie den macOS-Installer von [nodejs.org](https://nodejs.org/) herunter.
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
    
    Oder verwenden Sie einen Versionsmanager (siehe unten).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (empfohlen):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Oder laden Sie den Windows-Installer von [nodejs.org](https://nodejs.org/) herunter.
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Versionsmanager ermöglichen es Ihnen, einfach zwischen Node-Versionen zu wechseln. Beliebte Optionen:

- [**fnm**](https://github.com/Schniz/fnm) — schnell, plattformübergreifend
- [**nvm**](https://github.com/nvm-sh/nvm) — weit verbreitet auf macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglott (Node, Python, Ruby usw.)

Beispiel mit fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Stellen Sie sicher, dass Ihr Versionsmanager in Ihrer Shell-Startdatei initialisiert ist (`~/.zshrc` oder `~/.bashrc`). Ist dies nicht der Fall, wird `openclaw` in neuen Terminal-Sitzungen möglicherweise nicht gefunden, da der PATH das bin-Verzeichnis von Node nicht enthält.
  </Warning>
</Accordion>

## Fehlerbehebung

### `openclaw: command not found`

Das bedeutet fast immer, dass das globale bin-Verzeichnis von npm nicht in Ihrem PATH enthalten ist.

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
    Suchen Sie in der Ausgabe nach `<npm-prefix>/bin` (macOS/Linux) oder `<npm-prefix>` (Windows).
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Fügen Sie es zu `~/.zshrc` oder `~/.bashrc` hinzu:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Öffnen Sie anschließend ein neues Terminal (oder führen Sie `rehash` in zsh / `hash -r` in bash aus).
          </Tab>
          <Tab title="Windows">
            Fügen Sie die Ausgabe von `npm prefix -g` über Einstellungen → System → Umgebungsvariablen zu Ihrem System-PATH hinzu.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Berechtigungsfehler bei `npm install -g` (Linux)

Wenn Sie `EACCES`-Fehler sehen, wechseln Sie den globalen npm-Präfix zu einem für Benutzer beschreibbaren Verzeichnis:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Fügen Sie die Zeile `export PATH=...` zu Ihrer `~/.bashrc` oder `~/.zshrc` hinzu, um dies dauerhaft zu machen.
