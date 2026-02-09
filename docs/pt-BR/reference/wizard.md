---
summary: "Referência completa do assistente de onboarding da CLI: cada etapa, flag e campo de configuração"
read_when:
  - Consultar uma etapa ou flag específica do assistente
  - Automatizar o onboarding com o modo não interativo
  - Depurar o comportamento do assistente
title: "Referência do Assistente de Onboarding"
sidebarTitle: "Referência do Assistente"
---

# Referência do Assistente de Onboarding

Esta é a referência completa do assistente de CLI `openclaw onboard`.
Para uma visão geral de alto nível, veja [Onboarding Wizard](/start/wizard).

## Detalhes do fluxo (modo local)

<Steps>
  <Step title="Existing config detection">
    - Se `~/.openclaw/openclaw.json` existir, escolha **Manter / Modificar / Redefinir**.
    - Executar o assistente novamente **não** apaga nada a menos que você escolha explicitamente **Redefinir**
      (ou passe `--reset`).
    - Se a configuração for inválida ou contiver chaves legadas, o assistente para e solicita
      que você execute `openclaw doctor` antes de continuar.
    - A redefinição usa `trash` (nunca `rm`) e oferece escopos:
      - Apenas configuração
      - Configuração + credenciais + sessões
      - Redefinição completa (também remove o workspace)  
</Step>
  <Step title="Model/Auth">
    - **Chave de API da Anthropic (recomendado)**: usa `ANTHROPIC_API_KEY` se existir ou solicita uma chave e, em seguida, salva para uso do daemon.
    - **OAuth da Anthropic (Claude Code CLI)**: no macOS o assistente verifica o item do Keychain "Claude Code-credentials" (escolha "Sempre Permitir" para que inicializações via launchd não bloqueiem); no Linux/Windows ele reutiliza `~/.claude/.credentials.json` se existir.
    - **Token da Anthropic (colar setup-token)**: execute `claude setup-token` em qualquer máquina e depois cole o token (você pode nomeá-lo; em branco = padrão).
    - **Assinatura do OpenAI Code (Codex) (Codex CLI)**: se `~/.codex/auth.json` existir, o assistente pode reutilizá-la.
    - **Assinatura do OpenAI Code (Codex) (OAuth)**: fluxo no navegador; cole o `code#state`.
      - Define `agents.defaults.model` como `openai-codex/gpt-5.2` quando o modelo não está definido ou é `openai/*`.
    - **Chave de API do OpenAI**: usa `OPENAI_API_KEY` se existir ou solicita uma chave e, em seguida, salva em `~/.openclaw/.env` para que o launchd possa ler.
    - **Chave de API do xAI (Grok)**: solicita `XAI_API_KEY` e configura o xAI como provedor de modelo.
    - **OpenCode Zen (proxy multi‑modelo)**: solicita `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`, obtenha em https://opencode.ai/auth).
    - **Chave de API**: armazena a chave para você.
    - **Vercel AI Gateway (proxy multi‑modelo)**: solicita `AI_GATEWAY_API_KEY`.
    - Mais detalhes: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: solicita ID da Conta, ID do Gateway e `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Mais detalhes: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: a configuração é escrita automaticamente.
    - Mais detalhes: [MiniMax](/providers/minimax)
    - **Synthetic (compatível com Anthropic)**: solicita `SYNTHETIC_API_KEY`.
    - Mais detalhes: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: a configuração é escrita automaticamente.
    - **Kimi Coding**: a configuração é escrita automaticamente.
    - Mais detalhes: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Pular**: nenhuma autenticação configurada ainda.
    - Escolha um modelo padrão entre as opções detectadas (ou informe provedor/modelo manualmente).
    - O assistente executa uma verificação do modelo e avisa se o modelo configurado é desconhecido ou não tem autenticação.
    - As credenciais OAuth ficam em `~/.openclaw/credentials/oauth.json`; os perfis de autenticação ficam em `~/.openclaw/agents/
    - Credenciais do OAuth vivem em '~/.openclaw/credenciais/oauth.json'; perfis de autenticação vivem em '~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (chaves de API + OAuth).
    - Mais detalhes: [/concepts/oauth](/concepts/oauth)    
<Note>
    Dica para headless/servidor: conclua o OAuth em uma máquina com navegador e depois copie
    `~/.openclaw/credentials/oauth.json` (ou `$OPENCLAW_STATE_DIR/credentials/oauth.json`) para o
    host do Gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - Padrão `~/.openclaw/workspace` (configurável).
    - Inicializa os arquivos de workspace necessários para o ritual de bootstrap do agente.
    - Layout completo do workspace + guia de backup: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Porta, bind, modo de autenticação, exposição via Tailscale.
    - Recomendação de autenticação: mantenha **Token** mesmo para loopback para que clientes WS locais precisem se autenticar.
    - Desative a autenticação apenas se você confiar totalmente em todos os processos locais.
    - Binds não‑loopback ainda exigem autenticação.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): login por QR opcional.
    - [Telegram](/channels/telegram): token do bot.
    - [Discord](/channels/discord): token do bot.
    - [Google Chat](/channels/googlechat): JSON da conta de serviço + audiência do webhook.
    - [Mattermost](/channels/mattermost) (plugin): token do bot + URL base.
    - [Signal](/channels/signal): instalação opcional de `signal-cli` + configuração da conta.
    - [BlueBubbles](/channels/bluebubbles): **recomendado para iMessage**; URL do servidor + senha + webhook.
    - [iMessage](/channels/imessage): caminho legado da CLI `imsg` + acesso ao DB.
    - Segurança de DM: o padrão é pareamento. A primeira DM envia um código; aprove via `openclaw pairing approve <channel><code>` ou use listas de permissões.
  </Step><code>` ou use listas de permissões.
  </Step>
  <Step title="Instalação do daemon">
    - macOS: LaunchAgent
      - Requer uma sessão de usuário logada; para headless, use um LaunchDaemon personalizado (não fornecido).
    - Linux (e Windows via WSL2): unidade de usuário do systemd
      - O assistente tenta habilitar lingering via `loginctl enable-linger <user>` para que o Gateway permaneça ativo após logout.
      - Pode solicitar sudo (grava `/var/lib/systemd/linger`); ele tenta sem sudo primeiro.
    - **Seleção de runtime:** Node (recomendado; necessário para WhatsApp/Telegram). Bun **não é recomendado**.
  </Step>
  <Step title="Verificação de saúde">
    - Inicia o Gateway (se necessário) e executa `openclaw health`.
    - Dica: `openclaw status --deep` adiciona sondas de saúde do gateway à saída de status (requer um gateway acessível).
  </Step>
  <Step title="Skills (recomendado)">
    - Lê as skills disponíveis e verifica requisitos.
    - Permite escolher um gerenciador de pacotes Node: **npm / pnpm** (bun não recomendado).
    - Instala dependências opcionais (algumas usam Homebrew no macOS).
  </Step>
  <Step title="Finalizar">
    - Resumo + próximos passos, incluindo apps para iOS/Android/macOS para recursos extras.
  </Step>
</Steps>

<Note>
Se nenhuma GUI for detectada, o assistente imprime instruções de encaminhamento de porta SSH para a Control UI em vez de abrir um navegador.
Se os assets da Control UI estiverem ausentes, o assistente tenta compilá-los; o fallback é `pnpm ui:build` (instala automaticamente as dependências da UI).
</Note>

## Modo não interativo

Use `--non-interactive` para automatizar ou criar scripts de onboarding:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Adicione `--json` para um resumo legível por máquina.

<Note>
`--json` **não** implica modo não interativo. Use `--non-interactive` (e `--workspace`) para scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Adicionar agente (não interativo)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## RPC do assistente do Gateway

O Gateway expõe o fluxo do assistente via RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clientes (app macOS, Control UI) podem renderizar as etapas sem reimplementar a lógica de onboarding.

## Configuração do Signal (signal-cli)

O assistente pode instalar `signal-cli` a partir dos releases do GitHub:

- Baixa o asset de release apropriado.
- Armazena em `~/.openclaw/tools/signal-cli/<version>/`.
- Grava `channels.signal.cliPath` na sua configuração.

Notas:

- Builds JVM exigem **Java 21**.
- Builds nativas são usadas quando disponíveis.
- O Windows usa WSL2; a instalação do signal-cli segue o fluxo do Linux dentro do WSL.

## O que o assistente escreve

Campos típicos em `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (se Minimax for escolhido)
- `gateway.*` (modo, bind, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listas de permissões de canais (Slack/Discord/Matrix/Microsoft Teams) quando você opta durante os prompts (nomes resolvem para IDs quando possível).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` grava `agents.list[]` e `bindings` opcional.

As credenciais do WhatsApp ficam em `~/.openclaw/credentials/whatsapp/<accountId>/`.
As sessões são armazenadas em `~/.openclaw/agents/<agentId>/sessions/`.

Alguns canais são entregues como plugins. Ao escolher um durante o onboarding, o assistente
vai solicitar a instalação (npm ou um caminho local) antes que ele possa ser configurado.

## Documentos relacionados

- Visão geral do assistente: [Onboarding Wizard](/start/wizard)
- Onboarding do app macOS: [Onboarding](/start/onboarding)
- Referência de configuração: [Gateway configuration](/gateway/configuration)
- Provedores: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legado)
- Skills: [Skills](/tools/skills), [Configuração de Skills](/tools/skills-config)
