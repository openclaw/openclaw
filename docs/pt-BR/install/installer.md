---
summary: "Como funcionam os scripts do instalador (install.sh, install-cli.sh, install.ps1), flags e automação"
read_when:
  - Você quer entender `openclaw.ai/install.sh`
  - Você quer automatizar instalações (CI / headless)
  - Você quer instalar a partir de um checkout do GitHub
title: "Detalhes internos do instalador"
---

# Detalhes internos do instalador

O OpenClaw fornece três scripts de instalação, servidos em `openclaw.ai`.

| Script                             | Plataforma                              | O que ele faz                                                                                                                                     |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Instala o Node se necessário, instala o OpenClaw via npm (padrão) ou git e pode executar a integração inicial. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Instala Node + OpenClaw em um prefixo local (`~/.openclaw`). Não requer root.                  |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Instala o Node se necessário, instala o OpenClaw via npm (padrão) ou git e pode executar a integração inicial. |

## Comandos rápidos

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
Se a instalação for bem-sucedida, mas `openclaw` não for encontrado em um novo terminal, veja [Solução de problemas do Node.js](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Recomendado para a maioria das instalações interativas no macOS/Linux/WSL.
</Tip>

### Fluxo (install.sh)

<Steps>
  <Step title="Detect OS">
    Suporta macOS e Linux (incluindo WSL). Se o macOS for detectado, instala o Homebrew se estiver ausente.
  </Step>
  <Step title="Ensure Node.js 22+">
    Verifica a versão do Node e instala o Node 22 se necessário (Homebrew no macOS, scripts de setup do NodeSource no Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Instala o Git se estiver ausente.
  </Step>
  <Step title="Install OpenClaw">
    - Método `npm` (padrão): instalação global via npm
    - Método `git`: clonar/atualizar o repositório, instalar dependências com pnpm, compilar e então instalar o wrapper em `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - Executa `openclaw doctor --non-interactive` em upgrades e instalações via git (best effort)
    - Tenta a integração inicial quando apropriado (TTY disponível, integração inicial não desabilitada e verificações de bootstrap/configuração aprovadas)
    - Define `SHARP_IGNORE_GLOBAL_LIBVIPS=1` por padrão
  </Step>
</Steps>

### Detecção de checkout de código-fonte

Se executado dentro de um checkout do OpenClaw (`package.json` + `pnpm-workspace.yaml`), o script oferece:

- usar o checkout (`git`), ou
- usar a instalação global (`npm`)

Se nenhum TTY estiver disponível e nenhum método de instalação estiver definido, o padrão é `npm` e um aviso é exibido.

O script sai com o código `2` para seleção de método inválida ou valores inválidos de `--install-method`.

### Exemplos (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                              | Descrição                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Escolher método de instalação (padrão: `npm`). Alias: `--method` |
| `--npm`                           | Atalho para o método npm                                                                                                            |
| `--git`                           | Atalho para o método git. Alias: `--github`                                                         |
| `--version <version\\|dist-tag>` | Versão do npm ou dist-tag (padrão: `latest`)                                                     |
| `--beta`                          | Usar dist-tag beta se disponível; caso contrário, fallback para `latest`                                                            |
| `--git-dir <path>`                | Diretório de checkout (padrão: `~/openclaw`). Alias: `--dir`     |
| `--no-git-update`                 | Pular `git pull` para checkout existente                                                                                            |
| `--no-prompt`                     | Desabilitar prompts                                                                                                                 |
| `--no-onboard`                    | Pular integração                                                                                                                    |
| `--onboard`                       | Habilitar integração                                                                                                                |
| `--dry-run`                       | Imprimir ações sem aplicar alterações                                                                                               |
| `--verbose`                       | Habilitar saída de debug (`set -x`, logs do npm no nível notice)                                                 |
| `--help`                          | Mostrar uso (`-h`)                                                                                               |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variável                                        | Descrição                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Método de instalação                                                                      |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | Versão do npm ou dist-tag                                                                 |
| `OPENCLAW_BETA=0\\|1`                          | Usar beta se disponível                                                                   |
| `OPENCLAW_GIT_DIR=<path>`                       | Diretório de checkout                                                                     |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | Alternar atualizações via git                                                             |
| `OPENCLAW_NO_PROMPT=1`                          | Desabilitar prompts                                                                       |
| `OPENCLAW_NO_ONBOARD=1`                         | Pular integração                                                                          |
| `OPENCLAW_DRY_RUN=1`                            | Modo dry run                                                                              |
| `OPENCLAW_VERBOSE=1`                            | Modo de debug                                                                             |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Nível de log do npm                                                                       |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Controlar comportamento do sharp/libvips (padrão: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Projetado para ambientes em que você quer tudo sob um prefixo local (padrão `~/.openclaw`) e nenhuma dependência de Node do sistema.
</Info>

### Fluxo (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Baixa o tarball do Node (padrão `22.22.0`) para `<prefix>/tools/node-v<version>` e verifica o SHA-256.
  </Step>
  <Step title="Ensure Git">
    Se o Git estiver ausente, tenta instalar via apt/dnf/yum no Linux ou Homebrew no macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Instala com npm usando `--prefix <prefix>` e então grava o wrapper em `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Exemplos (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                   | Descrição                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `--prefix <path>`      | Prefixo de instalação (padrão: `~/.openclaw`)           |
| `--version <ver>`      | Versão do OpenClaw ou dist-tag (padrão: `latest`)       |
| `--node-version <ver>` | Versão do Node (padrão: `22.22.0`)                      |
| `--json`               | Emitir eventos NDJSON                                                                      |
| `--onboard`            | Executar `openclaw onboard` após a instalação                                              |
| `--no-onboard`         | Pular integração (padrão)                                               |
| `--set-npm-prefix`     | No Linux, forçar o prefixo do npm para `~/.npm-global` se o prefixo atual não for gravável |
| `--help`               | Mostrar uso (`-h`)                                                      |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variável                                        | Descrição                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Prefixo de instalação                                                                                            |
| `OPENCLAW_VERSION=<ver>`                        | Versão do OpenClaw ou dist-tag                                                                                   |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Versão do Node                                                                                                   |
| `OPENCLAW_NO_ONBOARD=1`                         | Pular integração                                                                                                 |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Nível de log do npm                                                                                              |
| `OPENCLAW_GIT_DIR=<path>`                       | Caminho de busca de limpeza legada (usado ao remover checkout antigo do submódulo `Peekaboo`) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Controlar comportamento do sharp/libvips (padrão: `1`)                        |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Fluxo (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Requer PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    Se estiver ausente, tenta instalar via winget, depois Chocolatey e então Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - Método `npm` (padrão): instalação global via npm usando o `-Tag` selecionado
    - Método `git`: clonar/atualizar o repositório, instalar/compilar com pnpm e instalar o wrapper em `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    Adiciona o diretório bin necessário ao PATH do usuário quando possível e então executa `openclaw doctor --non-interactive` em upgrades e instalações via git (best effort).
  </Step>
</Steps>

### Exemplos (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                        | Descrição                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Método de instalação (padrão: `npm`)                      |
| `-Tag <tag>`                | Dist-tag do npm (padrão: `latest`)                        |
| `-GitDir <path>`            | Diretório de checkout (padrão: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Pular integração                                                                             |
| `-NoGitUpdate`              | Pular `git pull`                                                                             |
| `-DryRun`                   | Imprimir apenas as ações                                                                     |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variável                             | Descrição             |
| ------------------------------------ | --------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Método de instalação  |
| `OPENCLAW_GIT_DIR=<path>`            | Diretório de checkout |
| `OPENCLAW_NO_ONBOARD=1`              | Pular integração      |
| `OPENCLAW_GIT_UPDATE=0`              | Desabilitar git pull  |
| `OPENCLAW_DRY_RUN=1`                 | Modo dry run          |

  </Accordion>
</AccordionGroup>

<Note>
Se `-InstallMethod git` for usado e o Git estiver ausente, o script encerra e imprime o link do Git for Windows.
</Note>

---

## CI e automação

Use flags/variáveis de ambiente não interativas para execuções previsíveis.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Solução de problemas

<AccordionGroup>
  <Accordion title="Why is Git required?">
    O Git é necessário para o método de instalação `git`. Para instalações `npm`, o Git ainda é verificado/instalado para evitar falhas `spawn git ENOENT` quando dependências usam URLs git.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Algumas configurações do Linux apontam o prefixo global do npm para caminhos pertencentes ao root. `install.sh` pode alternar o prefixo para `~/.npm-global` e acrescentar exports de PATH aos arquivos rc do shell (quando esses arquivos existem).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    Os scripts definem `SHARP_IGNORE_GLOBAL_LIBVIPS=1` por padrão para evitar que o sharp compile contra o libvips do sistema. Para sobrescrever:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Instale o Git for Windows, reabra o PowerShell e execute o instalador novamente.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Execute `npm config get prefix`, acrescente `\bin`, adicione esse diretório ao PATH do usuário e então reabra o PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Geralmente é um problema de PATH. Veja [Solução de problemas do Node.js](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
