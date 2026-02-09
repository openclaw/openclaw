---
summary: "Referência completa do fluxo de integração da CLI, configuração de autenticação/modelo, saídas e detalhes internos"
read_when:
  - Você precisa de comportamento detalhado para openclaw onboard
  - Você está depurando resultados de integração ou integrando clientes de integração
title: "Referência de Integração da CLI"
sidebarTitle: "Referência da CLI"
---

# Referência de Integração da CLI

Esta página é a referência completa para `openclaw onboard`.
Para o guia curto, veja [Assistente de Integração (CLI)](/start/wizard).

## O que o assistente faz

O modo local (padrão) orienta você por:

- Configuração de modelo e autenticação (OAuth da assinatura OpenAI Code, chave de API da Anthropic ou token de configuração, além de opções MiniMax, GLM, Moonshot e AI Gateway)
- Localização do workspace e arquivos de bootstrap
- Configurações do Gateway (porta, bind, autenticação, tailscale)
- Canais e provedores (Telegram, WhatsApp, Discord, Google Chat, plugin do Mattermost, Signal)
- Instalação do daemon (LaunchAgent ou unidade de usuário systemd)
- Health check
- Configuração de Skills

O modo remoto configura esta máquina para se conectar a um gateway em outro lugar.
Ele não instala nem modifica nada no host remoto.

## Detalhes do fluxo local

<Steps>
  <Step title="Existing config detection">
    - Se `~/.openclaw/openclaw.json` existir, escolha Manter, Modificar ou Redefinir.
    - Executar o assistente novamente não apaga nada a menos que você escolha explicitamente Redefinir (ou passe `--reset`).
    - Se a configuração for inválida ou contiver chaves legadas, o assistente para e solicita que você execute `openclaw doctor` antes de continuar.
    - A redefinição usa `trash` e oferece escopos:
      - Apenas configuração
      - Configuração + credenciais + sessões
      - Redefinição completa (também remove o workspace)  
</Step>
  <Step title="Model and auth">
    - A matriz completa de opções está em [Opções de autenticação e modelo](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Padrão `~/.openclaw/workspace` (configurável).
    - Semeia arquivos de espaço de trabalho necessários para o ritual de inicialização de primeira execução.
    - Inicializa arquivos do workspace necessários para o ritual de bootstrap da primeira execução.
    - Layout do workspace: [Workspace do agente](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Solicita porta, bind, modo de autenticação e exposição via tailscale.
    - Recomendado: manter a autenticação por token habilitada mesmo para loopback, para que clientes WS locais precisem se autenticar.
    - Desative a autenticação apenas se você confiar totalmente em todos os processos locais.
    - Binds não loopback ainda exigem autenticação.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): login por QR opcional
    - [Telegram](/channels/telegram): token do bot
    - [Discord](/channels/discord): token do bot
    - [Google Chat](/channels/googlechat): JSON da conta de serviço + público do webhook
    - Plugin do [Mattermost](/channels/mattermost): token do bot + URL base
    - [Signal](/channels/signal): instalação opcional de `signal-cli` + configuração da conta
    - [BlueBubbles](/channels/bluebubbles): recomendado para iMessage; URL do servidor + senha + webhook
    - [iMessage](/channels/imessage): caminho legado da CLI `imsg` + acesso ao BD
    - Segurança de DM: o padrão é pareamento. A primeira DM envia um código; aprove via
      `openclaw pairing approve <channel><code>` ou use listas de permissões.
  </Step><code>` ou use listas de permissões.
  </Step>
  <Step title="Instalação do daemon">
    - macOS: LaunchAgent
      - Requer sessão de usuário logada; para headless, use um LaunchDaemon personalizado (não fornecido).
    - Linux e Windows via WSL2: unidade de usuário systemd
      - O assistente tenta `loginctl enable-linger <user>` para que o gateway permaneça ativo após logout.
      - Pode solicitar sudo (grava `/var/lib/systemd/linger`); tenta sem sudo primeiro.
    - Seleção de runtime: Node (recomendado; obrigatório para WhatsApp e Telegram). Bun não é recomendado.
  </Step>
  <Step title="Verificação de integridade">
    - Inicia o gateway (se necessário) e executa `openclaw health`.
    - `openclaw status --deep` adiciona sondas de integridade do gateway à saída de status.
  </Step>
  <Step title="Skills">
    - Lê as skills disponíveis e verifica requisitos.
    - Permite escolher o gerenciador de pacotes Node: npm ou pnpm (bun não é recomendado).
    - Instala dependências opcionais (algumas usam Homebrew no macOS).
  </Step>
  <Step title="Finalizar">
    - Resumo e próximos passos, incluindo opções de apps para iOS, Android e macOS.
  </Step>
</Steps>

<Note>
Se nenhuma GUI for detectada, o assistente imprime instruções de encaminhamento de porta SSH para a Control UI em vez de abrir um navegador.
Se os assets da Control UI estiverem ausentes, o assistente tenta construí-los; o fallback é `pnpm ui:build` (instala automaticamente as dependências da UI).
</Note>

## Detalhes do modo remoto

O modo remoto configura esta máquina para se conectar a um gateway em outro lugar.

<Info>
O modo remoto não instala nem modifica nada no host remoto.
</Info>

O que você define:

- URL do gateway remoto (`ws://...`)
- Token se a autenticação do gateway remoto for necessária (recomendado)

<Note>
- Se o gateway for apenas loopback, use túnel SSH ou uma tailnet.
- Dicas de descoberta:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Opções de autenticação e modelo

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Usa `ANTHROPIC_API_KEY` se presente ou solicita uma chave, e então a salva para uso do daemon.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: verifica o item do Keychain "Claude Code-credentials"
    - Linux e Windows: reutiliza `~/.claude/.credentials.json` se presente

    ```
    No macOS, escolha "Sempre permitir" para que inicializações via launchd não sejam bloqueadas.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Execute `claude setup-token` em qualquer máquina e, em seguida, cole o token.
    Você pode nomeá-lo; em branco usa o padrão.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Se `~/.codex/auth.json` existir, o assistente pode reutilizá-la.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Fluxo no navegador; cole `code#state`.

    ```
    Define `agents.defaults.model` como `openai-codex/gpt-5.3-codex` quando o modelo não está definido ou é `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Usa `OPENAI_API_KEY` se presente ou solicita uma chave, e então a salva em
    `~/.openclaw/.env` para que o launchd possa lê-la.

    ```
    Define `agents.defaults.model` como `openai/gpt-5.1-codex` quando o modelo não está definido, é `openai/*` ou `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Solicita `XAI_API_KEY` e configura o xAI como provedor de modelo.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Solicita `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`).
    URL de configuração: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Armazena a chave para você.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Solicita `AI_GATEWAY_API_KEY`.
    Mais detalhes: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Solicita ID da conta, ID do gateway e `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Mais detalhes: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    A configuração é escrita automaticamente.
    Mais detalhes: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Solicita `SYNTHETIC_API_KEY`.
    Mais detalhes: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    As configurações do Moonshot (Kimi K2) e do Kimi Coding são escritas automaticamente.
    Mais detalhes: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Deixa a autenticação não configurada.
  </Accordion>
</AccordionGroup>

Comportamento do modelo:

- Escolhe o modelo padrão a partir das opções detectadas, ou permite inserir provedor e modelo manualmente.
- O assistente executa uma verificação do modelo e avisa se o modelo configurado for desconhecido ou estiver sem autenticação.

Caminhos de credenciais e perfis:

- Credenciais OAuth: `~/.openclaw/credentials/oauth.json`
- Perfis de autenticação (chaves de API + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Dica para headless e servidores: conclua o OAuth em uma máquina com navegador e, em seguida, copie
`~/.openclaw/credentials/oauth.json` (ou `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
para o host do gateway.
</Note>

## Saídas e detalhes internos

Campos típicos em `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (se Minimax for escolhido)
- `gateway.*` (modo, bind, autenticação, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listas de permissões de canais (Slack, Discord, Matrix, Microsoft Teams) quando você opta durante os prompts (nomes resolvem para IDs quando possível)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` grava `agents.list[]` e opcional `bindings`.

Credenciais do WhatsApp ficam em `~/.openclaw/credentials/whatsapp/<accountId>/`.
As sessões são armazenadas em `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Alguns canais são entregues como plugins. Quando selecionados durante a integração, o assistente
solicita a instalação do plugin (npm ou caminho local) antes da configuração do canal.
</Note>

RPC do assistente do Gateway:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Clientes (app macOS e Control UI) podem renderizar etapas sem reimplementar a lógica de integração.

Comportamento de configuração do Signal:

- Baixa o asset de release apropriado
- Armazena em `~/.openclaw/tools/signal-cli/<version>/`
- Grava `channels.signal.cliPath` na configuração
- Builds JVM exigem Java 21
- Builds nativas são usadas quando disponíveis
- No Windows usa WSL2 e segue o fluxo do signal-cli do Linux dentro do WSL

## Documentos relacionados

- Hub de integração: [Assistente de Integração (CLI)](/start/wizard)
- Automação e scripts: [Automação da CLI](/start/wizard-cli-automation)
- Referência de comandos: [`openclaw onboard`](/cli/onboard)
