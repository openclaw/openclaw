---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Node.js"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Install and configure Node.js for OpenClaw — version requirements, install options, and PATH troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - "You need to install Node.js before installing OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - "You installed OpenClaw but `openclaw` is command not found"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - "npm install -g fails with permissions or PATH issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Node.js（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw requires **Node 22 or newer**. The [installer script](/install#install-methods) will detect and install Node automatically — this page is for when you want to set up Node yourself and make sure everything is wired up correctly (versions, PATH, global installs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Check your version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node -v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If this prints `v22.x.x` or higher, you're good. If Node isn't installed or the version is too old, pick an install method below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install Node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="macOS">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    **Homebrew** (recommended):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    brew install node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Or download the macOS installer from [nodejs.org](https://nodejs.org/).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Linux">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    **Ubuntu / Debian:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sudo apt-get install -y nodejs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    **Fedora / RHEL:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sudo dnf install nodejs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Or use a version manager (see below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Windows">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    **winget** (recommended):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    winget install OpenJS.NodeJS.LTS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    **Chocolatey:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    choco install nodejs-lts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Or download the Windows installer from [nodejs.org](https://nodejs.org/).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Version managers let you switch between Node versions easily. Popular options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [**fnm**](https://github.com/Schniz/fnm) — fast, cross-platform（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [**nvm**](https://github.com/nvm-sh/nvm) — widely used on macOS/Linux（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example with fnm:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fnm install 22（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fnm use 22（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Warning>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Make sure your version manager is initialized in your shell startup file (`~/.zshrc` or `~/.bashrc`). If it isn't, `openclaw` may not be found in new terminal sessions because the PATH won't include Node's bin directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Warning>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `openclaw: command not found`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This almost always means npm's global bin directory isn't on your PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Find your global npm prefix">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    npm prefix -g（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Check if it's on your PATH">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    echo "$PATH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Look for `<npm-prefix>/bin` (macOS/Linux) or `<npm-prefix>` (Windows) in the output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Add it to your shell startup file">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="macOS / Linux">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        Add to `~/.zshrc` or `~/.bashrc`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        export PATH="$(npm prefix -g)/bin:$PATH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        Then open a new terminal (or run `rehash` in zsh / `hash -r` in bash).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <Tab title="Windows">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        Add the output of `npm prefix -g` to your system PATH via Settings → System → Environment Variables.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Permission errors on `npm install -g` (Linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see `EACCES` errors, switch npm's global prefix to a user-writable directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p "$HOME/.npm-global"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm config set prefix "$HOME/.npm-global"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export PATH="$HOME/.npm-global/bin:$PATH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add the `export PATH=...` line to your `~/.bashrc` or `~/.zshrc` to make it permanent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
