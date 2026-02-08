---
summary: "Guia completo de ponta a ponta para executar o OpenClaw como um assistente pessoal com cuidados de segurança"
read_when:
  - Integração inicial de uma nova instância de assistente
  - Revisão de implicações de segurança/permissões
title: "Configuração do Assistente Pessoal"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:11Z
---

# Criando um assistente pessoal com o OpenClaw

O OpenClaw é um gateway de WhatsApp + Telegram + Discord + iMessage para agentes **Pi**. Plugins adicionam Mattermost. Este guia é a configuração de “assistente pessoal”: um número dedicado de WhatsApp que se comporta como seu agente sempre ativo.

## ⚠️ Segurança em primeiro lugar

Você está colocando um agente em posição de:

- executar comandos na sua máquina (dependendo da configuração das ferramentas do Pi)
- ler/gravar arquivos no seu workspace
- enviar mensagens para fora via WhatsApp/Telegram/Discord/Mattermost (plugin)

Comece de forma conservadora:

- Sempre defina `channels.whatsapp.allowFrom` (nunca execute aberto para o mundo no seu Mac pessoal).
- Use um número de WhatsApp dedicado para o assistente.
- Heartbeats agora têm padrão de 30 minutos. Desative até confiar na configuração definindo `agents.defaults.heartbeat.every: "0m"`.

## Pré-requisitos

- OpenClaw instalado e integrado — veja [Primeiros passos](/start/getting-started) se você ainda não fez isso
- Um segundo número de telefone (SIM/eSIM/pré-pago) para o assistente

## A configuração com dois telefones (recomendado)

Você quer isto:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Se você vincular seu WhatsApp pessoal ao OpenClaw, cada mensagem para você vira “entrada do agente”. Isso raramente é o que você quer.

## Início rápido de 5 minutos

1. Pareie o WhatsApp Web (mostra o QR; escaneie com o telefone do assistente):

```bash
openclaw channels login
```

2. Inicie o Gateway (deixe-o em execução):

```bash
openclaw gateway --port 18789
```

3. Coloque uma configuração mínima em `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Agora envie uma mensagem para o número do assistente a partir do seu telefone na allowlist.

Quando a integração terminar, abrimos automaticamente o dashboard e imprimimos um link limpo (sem token). Se pedir autenticação, cole o token de `gateway.auth.token` nas configurações da Control UI. Para reabrir depois: `openclaw dashboard`.

## Dê ao agente um workspace (AGENTS)

O OpenClaw lê instruções operacionais e “memória” do diretório de workspace.

Por padrão, o OpenClaw usa `~/.openclaw/workspace` como workspace do agente e o criará (além dos arquivos iniciais `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automaticamente na configuração/primeira execução do agente. `BOOTSTRAP.md` só é criado quando o workspace é totalmente novo (ele não deve voltar depois que você o apagar). `MEMORY.md` é opcional (não é criado automaticamente); quando presente, é carregado para sessões normais. Sessões de subagentes injetam apenas `AGENTS.md` e `TOOLS.md`.

Dica: trate esta pasta como a “memória” do OpenClaw e torne-a um repositório git (idealmente privado) para que seus `AGENTS.md` + arquivos de memória tenham backup. Se o git estiver instalado, workspaces totalmente novos são inicializados automaticamente.

```bash
openclaw setup
```

Layout completo do workspace + guia de backup: [Agent workspace](/concepts/agent-workspace)  
Fluxo de trabalho de memória: [Memory](/concepts/memory)

Opcional: escolha um workspace diferente com `agents.defaults.workspace` (suporta `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Se você já distribui seus próprios arquivos de workspace a partir de um repositório, pode desativar completamente a criação de arquivos de bootstrap:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## A configuração que o transforma em “um assistente”

O OpenClaw vem com um bom padrão de assistente, mas você normalmente vai querer ajustar:

- persona/instruções em `SOUL.md`
- padrões de raciocínio (se desejado)
- heartbeats (quando você passar a confiar)

Exemplo:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Sessões e memória

- Arquivos de sessão: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Metadados da sessão (uso de tokens, última rota, etc.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legado: `~/.openclaw/sessions/sessions.json`)
- `/new` ou `/reset` inicia uma sessão nova para aquele chat (configurável via `resetTriggers`). Se enviado sozinho, o agente responde com um breve olá para confirmar o reset.
- `/compact [instructions]` compacta o contexto da sessão e informa o orçamento de contexto restante.

## Heartbeats (modo proativo)

Por padrão, o OpenClaw executa um heartbeat a cada 30 minutos com o prompt:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
Defina `agents.defaults.heartbeat.every: "0m"` para desativar.

- Se `HEARTBEAT.md` existir mas estiver efetivamente vazio (apenas linhas em branco e cabeçalhos markdown como `# Heading`), o OpenClaw pula a execução do heartbeat para economizar chamadas de API.
- Se o arquivo estiver ausente, o heartbeat ainda é executado e o modelo decide o que fazer.
- Se o agente responder com `HEARTBEAT_OK` (opcionalmente com um pequeno preenchimento; veja `agents.defaults.heartbeat.ackMaxChars`), o OpenClaw suprime a entrega de saída para aquele heartbeat.
- Heartbeats executam turnos completos do agente — intervalos menores consomem mais tokens.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Mídia de entrada e saída

Anexos de entrada (imagens/áudio/documentos) podem ser expostos ao seu comando via templates:

- `{{MediaPath}}` (caminho de arquivo temporário local)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (se a transcrição de áudio estiver habilitada)

Anexos de saída do agente: inclua `MEDIA:<path-or-url>` em sua própria linha (sem espaços). Exemplo:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

O OpenClaw extrai isso e envia como mídia junto com o texto.

## Checklist operacional

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Os logs ficam em `/tmp/openclaw/` (padrão: `openclaw-YYYY-MM-DD.log`).

## Próximos passos

- WebChat: [WebChat](/web/webchat)
- Operações do Gateway: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- Companion de menu do macOS: [OpenClaw macOS app](/platforms/macos)
- App de nó iOS: [iOS app](/platforms/ios)
- App de nó Android: [Android app](/platforms/android)
- Status do Windows: [Windows (WSL2)](/platforms/windows)
- Status do Linux: [Linux app](/platforms/linux)
- Segurança: [Security](/gateway/security)
