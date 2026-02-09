---
summary: "Assistente de integração inicial da CLI: configuração guiada para gateway, workspace, canais e skills"
read_when:
  - Ao executar ou configurar o assistente de integração inicial
  - Ao configurar uma nova máquina
title: "Assistente de Integração Inicial (CLI)"
sidebarTitle: "Integração inicial: CLI"
---

# Assistente de Integração Inicial (CLI)

O assistente de integração inicial é a forma **recomendada** de configurar o OpenClaw no macOS,
Linux ou Windows (via WSL2; fortemente recomendado).
Ele configura um Gateway local ou uma conexão com um Gateway remoto, além de canais, skills
e padrões de workspace em um único fluxo guiado.

```bash
openclaw onboard
```

<Info>
Primeiro chat mais rápido: abra a UI de Controle (não é necessário configurar canais). Execute
`openclaw dashboard` e converse no navegador. Documentação: [Dashboard](/web/dashboard).
</Info>

Para reconfigurar mais tarde:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` não implica modo não interativo. Para scripts, use `--non-interactive`.
</Note>

<Tip>
Recomendado: configure uma chave de API do Brave Search para que o agente possa usar `web_search`
(`web_fetch` funciona sem chave). Caminho mais fácil: `openclaw configure --section web`
que armazena `tools.web.search.apiKey`. Documentação: [Web tools](/tools/web).
</Tip>

## Início Rápido vs Avançado

O assistente começa com **Início Rápido** (padrões) vs **Avançado** (controle total).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - gateway local (loopback)
    - Workspace padrão (ou workspace existente)
    - Porta do Gateway **18789**
    - Autenticação do Gateway **Token** (gerado automaticamente, mesmo em loopback)
    - Exposição via Tailscale **Desligada**
    - DMs do Telegram + WhatsApp com **lista de permissões** por padrão (você será solicitado a informar seu número de telefone)
  </Tab>
  <Tab title="Advanced (full control)">
    - Expõe todas as etapas (modo, workspace, gateway, canais, daemon, skills).
  </Tab>
</Tabs>

## O que o assistente configura

O **modo local (padrão)** guia você pelas seguintes etapas:

1. **Modelo/Auth** — Chave de API da Anthropic (recomendado), OAuth, OpenAI ou outros provedores. Escolha um modelo padrão.
2. **Workspace** — Local para arquivos do agente (padrão `~/.openclaw/workspace`). Cria arquivos iniciais.
3. **Gateway** — Porta, endereço de bind, modo de autenticação, exposição via Tailscale.
4. **Canais** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles ou iMessage.
5. **Daemon** — Instala um LaunchAgent (macOS) ou uma unidade de usuário systemd (Linux/WSL2).
6. **Verificação de integridade** — Inicia o Gateway e verifica se está em execução.
7. **Skills** — Instala skills recomendadas e dependências opcionais.

<Note>
Executar o assistente novamente **não** apaga nada, a menos que você escolha explicitamente **Reset** (ou passe `--reset`).
Se a configuração for inválida ou contiver chaves legadas, o assistente solicitará que você execute `openclaw doctor` primeiro.
</Note>

O **modo remoto** apenas configura o cliente local para se conectar a um Gateway em outro lugar.
Ele **não** instala nem altera nada no host remoto.

## Adicionar outro agente

Use `openclaw agents add <name>` para criar um agente separado com seu próprio workspace,
sessões e perfis de autenticação. Executar sem `--workspace` inicia o assistente.

O que ele configura:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notas:

- Workspaces padrão seguem `~/.openclaw/workspace-<agentId>`.
- Adicione `bindings` para rotear mensagens de entrada (o assistente pode fazer isso).
- Flags não interativas: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Referência completa

Para detalhamentos passo a passo, scripts não interativos, configuração do Signal,
API RPC e uma lista completa dos campos de configuração que o assistente grava, consulte a
[Referência do Assistente](/reference/wizard).

## Documentos relacionados

- Referência de comandos da CLI: [`openclaw onboard`](/cli/onboard)
- Integração inicial do app macOS: [Onboarding](/start/onboarding)
- Ritual de primeira execução do agente: [Agent Bootstrapping](/start/bootstrapping)
