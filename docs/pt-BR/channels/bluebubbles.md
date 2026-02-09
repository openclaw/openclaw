---
summary: "iMessage via servidor BlueBubbles no macOS (envio/recebimento REST, digitação, reações, pareamento, ações avançadas)."
read_when:
  - Configurando o canal BlueBubbles
  - Solução de problemas de pareamento por webhook
  - Configurando o iMessage no macOS
title: "BlueBubbles"
---

# BlueBubbles (REST no macOS)

Status: plugin empacotado que se comunica com o servidor BlueBubbles no macOS via HTTP. **Recomendado para integração com iMessage** devido à API mais rica e à configuração mais simples em comparação com o canal legado imsg.

## Visão geral

- Roda no macOS via o aplicativo auxiliar BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- Recomendado/testado: macOS Sequoia (15). macOS Tahoe (26) funciona; a edição está atualmente quebrada no Tahoe, e atualizações de ícone de grupo podem reportar sucesso mas não sincronizar.
- O OpenClaw se comunica com ele por meio da API REST (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Mensagens de entrada chegam via webhooks; respostas de saída, indicadores de digitação, confirmações de leitura e tapbacks são chamadas REST.
- Anexos e figurinhas são ingeridos como mídia de entrada (e apresentados ao agente quando possível).
- Pareamento/lista de permissões funciona da mesma forma que em outros canais (`/channels/pairing` etc.) com `channels.bluebubbles.allowFrom` + códigos de pareamento.
- Reações são expostas como eventos de sistema, assim como no Slack/Telegram, para que agentes possam “mencioná-las” antes de responder.
- Recursos avançados: editar, desfazer envio, encadeamento de respostas, efeitos de mensagem, gerenciamento de grupos.

## Início rápido

1. Instale o servidor BlueBubbles no seu Mac (siga as instruções em [bluebubbles.app/install](https://bluebubbles.app/install)).

2. Na configuração do BlueBubbles, habilite a API web e defina uma senha.

3. Execute `openclaw onboard` e selecione BlueBubbles, ou configure manualmente:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Aponte os webhooks do BlueBubbles para o seu gateway (exemplo: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Inicie o gateway; ele registrará o manipulador de webhook e iniciará o pareamento.

## Mantendo o Messages.app ativo (VM / setups headless)

Alguns setups de VM no macOS / sempre ligados podem acabar com o Messages.app ficando “ocioso” (eventos de entrada param até que o app seja aberto/colocado em primeiro plano). Uma solução simples é **cutucar o Messages a cada 5 minutos** usando um AppleScript + LaunchAgent.

### 1. Salve o AppleScript

Salve como:

- `~/Scripts/poke-messages.scpt`

Script de exemplo (não interativo; não rouba foco):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Instale um LaunchAgent

Salve como:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Notas:

- Isso roda **a cada 300 segundos** e **no login**.
- A primeira execução pode acionar prompts de **Automação** do macOS (`osascript` → Messages). Aprove-os na mesma sessão de usuário que executa o LaunchAgent.

Carregue-o:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

O BlueBubbles está disponível no assistente interativo de configuração:

```
openclaw onboard
```

O assistente solicita:

- **URL do servidor** (obrigatório): endereço do servidor BlueBubbles (ex.: `http://192.168.1.100:1234`)
- **Senha** (obrigatório): senha da API nas configurações do BlueBubbles Server
- **Caminho do webhook** (opcional): padrão `/bluebubbles-webhook`
- **Política de DM**: pareamento, lista de permissões, aberto ou desativado
- **Lista de permissões**: números de telefone, e-mails ou alvos de chat

Você também pode adicionar o BlueBubbles via CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Controle de acesso (DMs + grupos)

DMs:

- Padrão: `channels.bluebubbles.dmPolicy = "pairing"`.
- Remetentes desconhecidos recebem um código de pareamento; as mensagens são ignoradas até a aprovação (os códigos expiram após 1 hora).
- Aprovar via:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- O pareamento é a troca de tokens padrão. Detalhes: [Pairing](/channels/pairing)

Grupos:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (padrão: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` controla quem pode acionar em grupos quando `allowlist` está definido.

### Bloqueio por menção (grupos)

O BlueBubbles suporta bloqueio por menção para chats em grupo, alinhado ao comportamento do iMessage/WhatsApp:

- Usa `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`) para detectar menções.
- Quando `requireMention` está habilitado para um grupo, o agente só responde quando é mencionado.
- Comandos de controle de remetentes autorizados ignoram o bloqueio por menção.

Configuração por grupo:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Bloqueio por comando

- Comandos de controle (ex.: `/config`, `/model`) exigem autorização.
- Usa `allowFrom` e `groupAllowFrom` para determinar a autorização de comandos.
- Remetentes autorizados podem executar comandos de controle mesmo sem mencionar em grupos.

## Digitação + confirmações de leitura

- **Indicadores de digitação**: enviados automaticamente antes e durante a geração da resposta.
- **Confirmações de leitura**: controladas por `channels.bluebubbles.sendReadReceipts` (padrão: `true`).
- **Indicadores de digitação**: o OpenClaw envia eventos de início de digitação; o BlueBubbles limpa a digitação automaticamente ao enviar ou por timeout (parada manual via DELETE é pouco confiável).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Ações avançadas

O BlueBubbles suporta ações avançadas de mensagem quando habilitadas na configuração:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Ações disponíveis:

- **react**: adicionar/remover reações tapback (`messageId`, `emoji`, `remove`)
- **edit**: editar uma mensagem enviada (`messageId`, `text`)
- **unsend**: desfazer o envio de uma mensagem (`messageId`)
- **reply**: responder a uma mensagem específica (`messageId`, `text`, `to`)
- **sendWithEffect**: enviar com efeito do iMessage (`text`, `to`, `effectId`)
- **renameGroup**: renomear um chat em grupo (`chatGuid`, `displayName`)
- **setGroupIcon**: definir o ícone/foto de um chat em grupo (`chatGuid`, `media`) — instável no macOS 26 Tahoe (a API pode retornar sucesso, mas o ícone não sincroniza).
- **addParticipant**: adicionar alguém a um grupo (`chatGuid`, `address`)
- **removeParticipant**: remover alguém de um grupo (`chatGuid`, `address`)
- **leaveGroup**: sair de um chat em grupo (`chatGuid`)
- **sendAttachment**: enviar mídia/arquivos (`to`, `buffer`, `filename`, `asVoice`)
  - Memorandos de voz: defina `asVoice: true` com áudio **MP3** ou **CAF** para enviar como mensagem de voz do iMessage. O BlueBubbles converte MP3 → CAF ao enviar memorandos de voz.

### IDs de mensagem (curtos vs completos)

O OpenClaw pode expor IDs de mensagem _curtos_ (ex.: `1`, `2`) para economizar tokens.

- `MessageSid` / `ReplyToId` podem ser IDs curtos.
- `MessageSidFull` / `ReplyToIdFull` contêm os IDs completos do provedor.
- IDs curtos ficam em memória; podem expirar em reinício ou por despejo de cache.
- As ações aceitam `messageId` curto ou completo, mas IDs curtos darão erro se não estiverem mais disponíveis.

Use IDs completos para automações e armazenamento duráveis:

- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Contexto: `MessageSidFull` / `ReplyToIdFull` em payloads de entrada

Veja [Configuration](/gateway/configuration) para variáveis de template.

## Streaming em blocos

Controle se as respostas são enviadas como uma única mensagem ou transmitidas em blocos:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Mídia + limites

- Anexos de entrada são baixados e armazenados no cache de mídia.
- Limite de mídia via `channels.bluebubbles.mediaMaxMb` (padrão: 8 MB).
- Texto de saída é fragmentado para `channels.bluebubbles.textChunkLimit` (padrão: 4000 caracteres).

## Referência de configuração

Configuração completa: [Configuration](/gateway/configuration)

Opções do provedor:

- `channels.bluebubbles.enabled`: Habilitar/desabilitar o canal.
- `channels.bluebubbles.serverUrl`: URL base da API REST do BlueBubbles.
- `channels.bluebubbles.password`: Senha da API.
- `channels.bluebubbles.webhookPath`: Caminho do endpoint de webhook (padrão: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (padrão: `pairing`).
- `channels.bluebubbles.allowFrom`: Lista de permissões de DM (identificadores, e-mails, números E.164, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (padrão: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Lista de permissões de remetentes em grupos.
- `channels.bluebubbles.groups`: Configuração por grupo (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts`: Enviar confirmações de leitura (padrão: `true`).
- `channels.bluebubbles.blockStreaming`: Habilitar streaming em blocos (padrão: `false`; necessário para respostas em streaming).
- `channels.bluebubbles.textChunkLimit`: Tamanho do bloco de saída em caracteres (padrão: 4000).
- `channels.bluebubbles.chunkMode`: `length` (padrão) divide apenas quando excede `textChunkLimit`; `newline` divide em linhas em branco (limites de parágrafo) antes da fragmentação por comprimento.
- `channels.bluebubbles.mediaMaxMb`: Limite de mídia de entrada em MB (padrão: 8).
- `channels.bluebubbles.historyLimit`: Máximo de mensagens de grupo para contexto (0 desativa).
- `channels.bluebubbles.dmHistoryLimit`: Limite de histórico de DMs.
- `channels.bluebubbles.actions`: Habilitar/desabilitar ações específicas.
- `channels.bluebubbles.accounts`: Configuração multi-conta.

Opções globais relacionadas:

- `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Endereçamento / destinos de entrega

Prefira `chat_guid` para roteamento estável:

- `chat_guid:iMessage;-;+15555550123` (preferido para grupos)
- `chat_id:123`
- `chat_identifier:...`
- Identificadores diretos: `+15555550123`, `user@example.com`
  - Se um identificador direto não tiver um chat de DM existente, o OpenClaw criará um via `POST /api/v1/chat/new`. Isso requer que a API Privada do BlueBubbles esteja habilitada.

## Segurança

- Requisições de webhook são autenticadas comparando os parâmetros de consulta ou cabeçalhos `guid`/`password` com `channels.bluebubbles.password`. Requisições de `localhost` também são aceitas.
- Mantenha a senha da API e o endpoint do webhook em segredo (trate-os como credenciais).
- Confiança em localhost significa que um proxy reverso no mesmo host pode inadvertidamente contornar a senha. Se você fizer proxy do gateway, exija autenticação no proxy e configure `gateway.trustedProxies`. Veja [Gateway security](/gateway/security#reverse-proxy-configuration).
- Habilite HTTPS + regras de firewall no servidor BlueBubbles se expô-lo fora da sua LAN.

## Solução de problemas

- Se eventos de digitação/leitura pararem de funcionar, verifique os logs de webhook do BlueBubbles e confirme que o caminho do gateway corresponde a `channels.bluebubbles.webhookPath`.
- Códigos de pareamento expiram após uma hora; use `openclaw pairing list bluebubbles` e `openclaw pairing approve bluebubbles <code>`.
- Reações exigem a API privada do BlueBubbles (`POST /api/v1/message/react`); garanta que a versão do servidor a exponha.
- Editar/desfazer envio exigem macOS 13+ e uma versão compatível do servidor BlueBubbles. No macOS 26 (Tahoe), a edição está atualmente quebrada devido a mudanças na API privada.
- Atualizações de ícone de grupo podem ser instáveis no macOS 26 (Tahoe): a API pode retornar sucesso, mas o novo ícone não sincroniza.
- O OpenClaw oculta automaticamente ações conhecidamente quebradas com base na versão do macOS do servidor BlueBubbles. Se editar ainda aparecer no macOS 26 (Tahoe), desative manualmente com `channels.bluebubbles.actions.edit=false`.
- Para informações de status/saúde: `openclaw status --all` ou `openclaw status --deep`.

Para referência geral do fluxo de canais, veja [Channels](/channels) e o guia de [Plugins](/tools/plugin).
