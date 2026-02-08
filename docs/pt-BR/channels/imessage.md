---
summary: "Suporte legado ao iMessage via imsg (JSON-RPC sobre stdio). Novas configurações devem usar o BlueBubbles."
read_when:
  - Configurando suporte ao iMessage
  - Depurando envio/recebimento do iMessage
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:18Z
---

# iMessage (legado: imsg)

> **Recomendado:** Use [BlueBubbles](/channels/bluebubbles) para novas configurações do iMessage.
>
> O canal `imsg` é uma integração legada via CLI externa e pode ser removido em uma versão futura.

Status: integração legada via CLI externa. O Gateway inicia `imsg rpc` (JSON-RPC sobre stdio).

## Início rápido (iniciante)

1. Garanta que o Messages esteja conectado neste Mac.
2. Instale `imsg`:
   - `brew install steipete/tap/imsg`
3. Configure o OpenClaw com `channels.imessage.cliPath` e `channels.imessage.dbPath`.
4. Inicie o gateway e aprove quaisquer prompts do macOS (Automação + Acesso Total ao Disco).

Configuração mínima:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## O que é

- Canal do iMessage baseado em `imsg` no macOS.
- Roteamento determinístico: respostas sempre retornam ao iMessage.
- DMs compartilham a sessão principal do agente; grupos são isolados (`agent:<agentId>:imessage:group:<chat_id>`).
- Se um tópico com múltiplos participantes chegar com `is_group=false`, você ainda pode isolá-lo `chat_id` usando `channels.imessage.groups` (veja “Tópicos tipo grupo” abaixo).

## Escritas de configuração

Por padrão, o iMessage tem permissão para escrever atualizações de configuração acionadas por `/config set|unset` (requer `commands.config: true`).

Desative com:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Requisitos

- macOS com o Messages conectado.
- Acesso Total ao Disco para o OpenClaw + `imsg` (acesso ao DB do Messages).
- Permissão de Automação ao enviar.
- `channels.imessage.cliPath` pode apontar para qualquer comando que faça proxy de stdin/stdout (por exemplo, um script wrapper que conecta via SSH a outro Mac e executa `imsg rpc`).

## Solução de problemas de Privacidade e Segurança TCC do macOS

Se o envio/recebimento falhar (por exemplo, `imsg rpc` sai com código diferente de zero, expira, ou o gateway parece travar), uma causa comum é um prompt de permissão do macOS que nunca foi aprovado.

O macOS concede permissões TCC por app/contexto de processo. Aprove os prompts no mesmo contexto que executa `imsg` (por exemplo, Terminal/iTerm, uma sessão LaunchAgent ou um processo iniciado via SSH).

Checklist:

- **Acesso Total ao Disco**: permita acesso ao processo que executa o OpenClaw (e a qualquer wrapper de shell/SSH que execute `imsg`). Isso é necessário para ler o banco de dados do Messages (`chat.db`).
- **Automação → Messages**: permita que o processo que executa o OpenClaw (e/ou seu terminal) controle o **Messages.app** para envios de saída.
- **Saúde da CLI `imsg`**: verifique se `imsg` está instalado e oferece suporte a RPC (`imsg rpc --help`).

Dica: Se o OpenClaw estiver rodando sem interface (LaunchAgent/systemd/SSH), o prompt do macOS pode ser fácil de perder. Execute um comando interativo único em um terminal com GUI para forçar o prompt e, em seguida, tente novamente:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Permissões de pastas relacionadas do macOS (Desktop/Documentos/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).

## Configuração (caminho rápido)

1. Garanta que o Messages esteja conectado neste Mac.
2. Configure o iMessage e inicie o gateway.

### Usuário macOS dedicado para bot (para identidade isolada)

Se você quiser que o bot envie a partir de uma **identidade iMessage separada** (e manter seus Messages pessoais limpos), use um Apple ID dedicado + um usuário macOS dedicado.

1. Crie um Apple ID dedicado (exemplo: `my-cool-bot@icloud.com`).
   - A Apple pode exigir um número de telefone para verificação / 2FA.
2. Crie um usuário macOS (exemplo: `openclawhome`) e faça login nele.
3. Abra o Messages nesse usuário macOS e entre no iMessage usando o Apple ID do bot.
4. Ative o Login Remoto (Ajustes do Sistema → Geral → Compartilhamento → Login Remoto).
5. Instale `imsg`:
   - `brew install steipete/tap/imsg`
6. Configure o SSH para que `ssh <bot-macos-user>@localhost true` funcione sem senha.
7. Aponte `channels.imessage.accounts.bot.cliPath` para um wrapper SSH que execute `imsg` como o usuário do bot.

Nota da primeira execução: enviar/receber pode exigir aprovações de GUI (Automação + Acesso Total ao Disco) no _usuário macOS do bot_. Se `imsg rpc` parecer travado ou encerrar, faça login nesse usuário (Compartilhamento de Tela ajuda), execute um `imsg chats --limit 1` / `imsg send ...` único, aprove os prompts e tente novamente. Veja [Solução de problemas de Privacidade e Segurança TCC do macOS](#troubleshooting-macos-privacy-and-security-tcc).

Wrapper de exemplo (`chmod +x`). Substitua `<bot-macos-user>` pelo seu nome de usuário macOS real:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Configuração de exemplo:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Para configurações de conta única, use opções simples (`channels.imessage.cliPath`, `channels.imessage.dbPath`) em vez do mapa `accounts`.

### Variante remota/SSH (opcional)

Se você quiser o iMessage em outro Mac, defina `channels.imessage.cliPath` para um wrapper que execute `imsg` no host macOS remoto via SSH. O OpenClaw precisa apenas de stdio.

Wrapper de exemplo:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Anexos remotos:** Quando `cliPath` aponta para um host remoto via SSH, os caminhos de anexos no banco de dados do Messages referenciam arquivos na máquina remota. O OpenClaw pode buscar esses arquivos automaticamente via SCP ao definir `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

Se `remoteHost` não estiver definido, o OpenClaw tenta detectá-lo automaticamente analisando o comando SSH no seu script wrapper. A configuração explícita é recomendada para confiabilidade.

#### Mac remoto via Tailscale (exemplo)

Se o Gateway roda em um host/VM Linux, mas o iMessage precisa rodar em um Mac, o Tailscale é a ponte mais simples: o Gateway se comunica com o Mac pela tailnet, executa `imsg` via SSH e copia anexos de volta via SCP.

Arquitetura:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Exemplo concreto de configuração (hostname do Tailscale):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Wrapper de exemplo (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Notas:

- Garanta que o Mac esteja conectado ao Messages e que o Login Remoto esteja ativado.
- Use chaves SSH para que `ssh bot@mac-mini.tailnet-1234.ts.net` funcione sem prompts.
- `remoteHost` deve corresponder ao destino SSH para que o SCP possa buscar anexos.

Suporte a múltiplas contas: use `channels.imessage.accounts` com configuração por conta e `name` opcional. Veja [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para o padrão compartilhado. Não versionar `~/.openclaw/openclaw.json` (geralmente contém tokens).

## Controle de acesso (DMs + grupos)

DMs:

- Padrão: `channels.imessage.dmPolicy = "pairing"`.
- Remetentes desconhecidos recebem um código de pareamento; as mensagens são ignoradas até a aprovação (códigos expiram após 1 hora).
- Aprovar via:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- O pareamento é a troca de tokens padrão para DMs do iMessage. Detalhes: [Pareamento](/channels/pairing)

Grupos:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` controla quem pode acionar em grupos quando `allowlist` está definido.
- O bloqueio por menção usa `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`) porque o iMessage não tem metadados nativos de menção.
- Substituição multiagente: defina padrões por agente em `agents.list[].groupChat.mentionPatterns`.

## Como funciona (comportamento)

- `imsg` transmite eventos de mensagens; o gateway os normaliza no envelope de canal compartilhado.
- As respostas sempre retornam ao mesmo id de chat ou handle.

## Tópicos tipo grupo (`is_group=false`)

Alguns tópicos do iMessage podem ter vários participantes, mas ainda chegar com `is_group=false`, dependendo de como o Messages armazena o identificador do chat.

Se você configurar explicitamente um `chat_id` em `channels.imessage.groups`, o OpenClaw trata esse tópico como um “grupo” para:

- isolamento de sessão (chave de sessão `agent:<agentId>:imessage:group:<chat_id>` separada)
- comportamento de lista de permissões de grupo / bloqueio por menção

Exemplo:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

Isso é útil quando você quer uma personalidade/modelo isolado para um tópico específico (veja [Roteamento multiagente](/concepts/multi-agent)). Para isolamento de filesystem, veja [Sandboxing](/gateway/sandboxing).

## Mídia + limites

- Ingestão opcional de anexos via `channels.imessage.includeAttachments`.
- Limite de mídia via `channels.imessage.mediaMaxMb`.

## Limites

- Texto de saída é dividido em blocos de `channels.imessage.textChunkLimit` (padrão 4000).
- Divisão opcional por nova linha: defina `channels.imessage.chunkMode="newline"` para dividir em linhas em branco (limites de parágrafo) antes da divisão por tamanho.
- Uploads de mídia são limitados por `channels.imessage.mediaMaxMb` (padrão 16).

## Endereçamento / destinos de entrega

Prefira `chat_id` para roteamento estável:

- `chat_id:123` (preferido)
- `chat_guid:...`
- `chat_identifier:...`
- handles diretos: `imessage:+1555` / `sms:+1555` / `user@example.com`

Listar chats:

```
imsg chats --limit 20
```

## Referência de configuração (iMessage)

Configuração completa: [Configuração](/gateway/configuration)

Opções do provedor:

- `channels.imessage.enabled`: habilitar/desabilitar a inicialização do canal.
- `channels.imessage.cliPath`: caminho para `imsg`.
- `channels.imessage.dbPath`: caminho do DB do Messages.
- `channels.imessage.remoteHost`: host SSH para transferência de anexos via SCP quando `cliPath` aponta para um Mac remoto (por exemplo, `user@gateway-host`). Auto-detectado a partir do wrapper SSH se não estiver definido.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: região de SMS.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (padrão: pareamento).
- `channels.imessage.allowFrom`: lista de permissões de DM (handles, e-mails, números E.164 ou `chat_id:*`). `open` requer `"*"`. O iMessage não tem nomes de usuário; use handles ou destinos de chat.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (padrão: lista de permissões).
- `channels.imessage.groupAllowFrom`: lista de permissões de remetentes de grupo.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: máximo de mensagens de grupo a incluir como contexto (0 desativa).
- `channels.imessage.dmHistoryLimit`: limite de histórico de DM em turnos de usuário. Substituições por usuário: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: padrões por grupo + lista de permissões (use `"*"` para padrões globais).
- `channels.imessage.includeAttachments`: ingerir anexos no contexto.
- `channels.imessage.mediaMaxMb`: limite de mídia de entrada/saída (MB).
- `channels.imessage.textChunkLimit`: tamanho de bloco de saída (caracteres).
- `channels.imessage.chunkMode`: `length` (padrão) ou `newline` para dividir em linhas em branco (limites de parágrafo) antes da divisão por tamanho.

Opções globais relacionadas:

- `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
