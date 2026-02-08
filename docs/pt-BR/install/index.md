---
summary: "Instale o OpenClaw — script de instalação, npm/pnpm, a partir do código-fonte, Docker e mais"
read_when:
  - Você precisa de um método de instalação diferente do Início rápido de Primeiros passos
  - Você quer implantar em uma plataforma de nuvem
  - Você precisa atualizar, migrar ou desinstalar
title: "Instalação"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:16Z
---

# Instalação

Já seguiu [Primeiros passos](/start/getting-started)? Então está tudo pronto — esta página é para métodos alternativos de instalação, instruções específicas por plataforma e manutenção.

## Requisitos do sistema

- **[Node 22+](/install/node)** (o [script de instalação](#install-methods) irá instalá-lo se estiver ausente)
- macOS, Linux ou Windows
- `pnpm` apenas se você compilar a partir do código-fonte

<Note>
No Windows, recomendamos fortemente executar o OpenClaw no [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Métodos de instalação

<Tip>
O **script de instalação** é a forma recomendada de instalar o OpenClaw. Ele cuida da detecção do Node, da instalação e da integração inicial em uma única etapa.
</Tip>

<AccordionGroup>
  <Accordion title="Script de instalação" icon="rocket" defaultOpen>
    Baixa a CLI, instala globalmente via npm e inicia o assistente de integração inicial.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    É isso — o script cuida da detecção do Node, da instalação e da integração inicial.

    Para pular a integração inicial e apenas instalar o binário:

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    Para todas as flags, variáveis de ambiente e opções de CI/automação, consulte [Detalhes internos do instalador](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Se você já tem o Node 22+ e prefere gerenciar a instalação por conta própria:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="erros de build do sharp?">
          Se você tiver o libvips instalado globalmente (comum no macOS via Homebrew) e `sharp` falhar, force binários pré-compilados:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Se você vir `sharp: Please add node-gyp to your dependencies`, instale as ferramentas de build (macOS: Xcode CLT + `npm install -g node-gyp`) ou use a variável de ambiente acima.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        O pnpm exige aprovação explícita para pacotes com scripts de build. Depois que a primeira instalação mostrar o aviso "Ignored build scripts", execute `pnpm approve-builds -g` e selecione os pacotes listados.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="A partir do código-fonte" icon="github">
    Para colaboradores ou qualquer pessoa que queira executar a partir de um checkout local.

    <Steps>
      <Step title="Clonar e compilar">
        Clone o [repositório do OpenClaw](https://github.com/openclaw/openclaw) e compile:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Vincular a CLI">
        Torne o comando `openclaw` disponível globalmente:

        ```bash
        pnpm link --global
        ```

        Como alternativa, pule o vínculo e execute os comandos via `pnpm openclaw ...` de dentro do repositório.
      </Step>
      <Step title="Executar a integração inicial">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Para fluxos de desenvolvimento mais avançados, consulte [Configuração](/start/setup).

  </Accordion>
</AccordionGroup>

## Outros métodos de instalação

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Implantações conteinerizadas ou headless.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Instalação declarativa via Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Provisionamento automatizado de frotas.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Uso somente da CLI via o runtime Bun.
  </Card>
</CardGroup>

## Após a instalação

Verifique se tudo está funcionando:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Solução de problemas: `openclaw` não encontrado

<Accordion title="Diagnóstico e correção do PATH">
  Diagnóstico rápido:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Se `$(npm prefix -g)/bin` (macOS/Linux) ou `$(npm prefix -g)` (Windows) **não** estiver no seu `$PATH`, seu shell não consegue encontrar binários globais do npm (incluindo `openclaw`).

Correção — adicione-o ao arquivo de inicialização do seu shell (`~/.zshrc` ou `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

No Windows, adicione a saída de `npm prefix -g` ao seu PATH.

Em seguida, abra um novo terminal (ou `rehash` no zsh / `hash -r` no bash).
</Accordion>

## Atualizar / desinstalar

<CardGroup cols={3}>
  <Card title="Atualização" href="/install/updating" icon="refresh-cw">
    Mantenha o OpenClaw atualizado.
  </Card>
  <Card title="Migração" href="/install/migrating" icon="arrow-right">
    Mude para uma nova máquina.
  </Card>
  <Card title="Desinstalação" href="/install/uninstall" icon="trash-2">
    Remova o OpenClaw completamente.
  </Card>
</CardGroup>
