---
title: "Node.js"
summary: "Instalacja i konfiguracja Node.js dla OpenClaw — wymagania wersji, opcje instalacji oraz rozwiązywanie problemów z PATH"
read_when:
  - "Musisz zainstalować Node.js przed instalacją OpenClaw"
  - "Zainstalowałeś OpenClaw, ale polecenie `openclaw` nie zostało znalezione"
  - "npm install -g kończy się błędami uprawnień lub problemami z PATH"
---

# Node.js

OpenClaw wymaga **Node 22 lub nowszego**. [Skrypt instalatora](/install#install-methods) wykryje i zainstaluje Node automatycznie — ta strona jest przeznaczona dla przypadków, gdy chcesz skonfigurować Node samodzielnie i upewnić się, że wszystko jest poprawnie połączone (wersje, PATH, instalacje globalne).

## Sprawdź wersję

```bash
node -v
```

Jeśli to polecenie wypisze `v22.x.x` lub wyższą wersję, wszystko jest w porządku. Jeśli Node nie jest zainstalowany lub wersja jest zbyt stara, wybierz jedną z metod instalacji poniżej.

## Instalacja Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (zalecane):

    ````
    ```bash
    brew install node
    ```
    
    Lub pobierz instalator macOS z [nodejs.org](https://nodejs.org/).
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
    
    Lub użyj menedżera wersji (zobacz poniżej).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (zalecane):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Lub pobierz instalator Windows z [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Menedżery wersji umożliwiają łatwe przełączanie się między wersjami Node. Popularne opcje:

- [**fnm**](https://github.com/Schniz/fnm) — szybki, wieloplatformowy
- [**nvm**](https://github.com/nvm-sh/nvm) — szeroko używany na macOS/Linux
- [**mise**](https://mise.jdx.dev/) — poliglot (Node, Python, Ruby itd.)

Przykład z fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Upewnij się, że menedżer wersji jest inicjalizowany w pliku startowym powłoki (`~/.zshrc` lub `~/.bashrc`). Jeśli nie, `openclaw` może nie zostać znalezione w nowych sesjach terminala, ponieważ PATH nie będzie zawierać katalogu bin Node.
  </Warning>
</Accordion>

## Rozwiązywanie problemów

### `openclaw: command not found`

Zazwyczaj oznacza to, że globalny katalog bin npm nie znajduje się w PATH.

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
    Poszukaj `<npm-prefix>/bin` (macOS/Linux) lub `<npm-prefix>` (Windows) w wyjściu.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Dodaj do `~/.zshrc` lub `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Następnie otwórz nowy terminal (lub uruchom `rehash` w zsh / `hash -r` w bash).
          </Tab>
          <Tab title="Windows">
            Dodaj wynik `npm prefix -g` do systemowego PATH przez Ustawienia → System → Zmienne środowiskowe.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Błędy uprawnień przy `npm install -g` (Linux)

Jeśli widzisz błędy `EACCES`, zmień globalny prefiks npm na katalog zapisywalny przez użytkownika:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Dodaj linię `export PATH=...` do `~/.bashrc` lub `~/.zshrc`, aby zmiana była trwała.
