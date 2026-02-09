---
summary: "Configuração do Slack para modo socket ou webhook HTTP"
read_when: "Ao configurar o Slack ou depurar o modo socket/HTTP do Slack"
title: "Slack"
---

# Slack

## Modo Socket (padrão)

### Configuração rápida (iniciante)

1. Crie um app do Slack e habilite o **Socket Mode**.
2. Crie um **App Token** (`xapp-...`) e um **Bot Token** (`xoxb-...`).
3. Defina os tokens para o OpenClaw e inicie o gateway.

Configuração mínima:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Configuração

1. Crie um app do Slack (From scratch) em [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → ative. Em seguida vá para **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** com o escopo `connections:write`. Copie o **App Token** (`xapp-...`).
3. **OAuth & Permissions** → adicione os escopos do bot (use o manifesto abaixo). Clique em **Install to Workspace**. Copie o **Bot User OAuth Token** (`xoxb-...`).
4. Opcional: **OAuth & Permissions** → adicione **User Token Scopes** (veja a lista somente leitura abaixo). Reinstale o app e copie o **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → habilite eventos e assine:
   - `message.*` (inclui edições/exclusões/broadcasts de thread)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Convide o bot para os canais que você quer que ele leia.
7. Slash Commands → crie `/openclaw` se você usar `channels.slack.slashCommand`. Se você habilitar comandos nativos, adicione um comando de barra por comando embutido (mesmos nomes de `/help`). O modo nativo vem desativado por padrão para o Slack, a menos que você defina `channels.slack.commands.native: true` (o `commands.native` global é `"auto"`, que mantém o Slack desativado).
8. App Home → habilite a **Messages Tab** para que usuários possam enviar DM ao bot.

Use o manifesto abaixo para manter escopos e eventos sincronizados.

Suporte a múltiplas contas: use `channels.slack.accounts` com tokens por conta e `name` opcional. Veja [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para o padrão compartilhado.

### Configuração do OpenClaw (Modo Socket)

Defina os tokens via variáveis de ambiente (recomendado):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Ou via configuração:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Token de usuário (opcional)

O OpenClaw pode usar um token de usuário do Slack (`xoxp-...`) para operações de leitura (histórico,
pins, reações, emoji, informações de membros). Por padrão, ele permanece somente leitura: leituras
preferem o token de usuário quando presente, e gravações ainda usam o token do bot, a menos
que você opte explicitamente. Mesmo com `userTokenReadOnly: false`, o token do bot continua
preferido para gravações quando está disponível.

Tokens de usuário são configurados no arquivo de configuração (sem suporte a variáveis de ambiente). Para
múltiplas contas, defina `channels.slack.accounts.<id>.userToken`.

Exemplo com tokens de bot + app + usuário:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Exemplo com userTokenReadOnly definido explicitamente (permitir gravações com token de usuário):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Uso de tokens

- Operações de leitura (histórico, lista de reações, lista de pins, lista de emojis, informações de membros,
  busca) preferem o token de usuário quando configurado; caso contrário, o token do bot.
- Operações de gravação (enviar/editar/excluir mensagens, adicionar/remover reações, pin/unpin,
  upload de arquivos) usam o token do bot por padrão. Se `userTokenReadOnly: false` e
  nenhum token de bot estiver disponível, o OpenClaw recorre ao token de usuário.

### Contexto de histórico

- `channels.slack.historyLimit` (ou `channels.slack.accounts.*.historyLimit`) controla quantas mensagens recentes de canal/grupo são incluídas no prompt.
- Volta para `messages.groupChat.historyLimit`. Defina `0` para desativar (padrão 50).

## Modo HTTP (Events API)

Use o modo webhook HTTP quando seu Gateway for acessível pelo Slack via HTTPS (típico para implantações em servidor).
O modo HTTP usa a Events API + Interactivity + Slash Commands com uma URL de requisição compartilhada.

### Configuração (Modo HTTP)

1. Crie um app do Slack e **desative o Socket Mode** (opcional se você usar apenas HTTP).
2. **Basic Information** → copie o **Signing Secret**.
3. **OAuth & Permissions** → instale o app e copie o **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → habilite eventos e defina a **Request URL** para o caminho de webhook do seu gateway (padrão `/slack/events`).
5. **Interactivity & Shortcuts** → habilite e defina a mesma **Request URL**.
6. **Slash Commands** → defina a mesma **Request URL** para seu(s) comando(s).

Exemplo de URL de requisição:
`https://gateway-host/slack/events`

### Configuração do OpenClaw (mínima)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

Modo HTTP com múltiplas contas: defina `channels.slack.accounts.<id>.mode = "http"` e forneça um
`webhookPath` exclusivo por conta para que cada app do Slack possa apontar para sua própria URL.

### Manifesto (opcional)

Use este manifesto de app do Slack para criar o app rapidamente (ajuste o nome/comando se quiser). Inclua os
escopos de usuário se você planeja configurar um token de usuário.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Se você habilitar comandos nativos, adicione uma entrada `slash_commands` por comando que deseja expor (correspondendo à lista `/help`). Substitua com `channels.slack.commands.native`.

## Escopos (atuais vs opcionais)

A Conversations API do Slack é escopada por tipo: você só precisa dos escopos para os
tipos de conversa que realmente usa (channels, groups, im, mpim). Veja
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) para uma visão geral.

### Escopos do token do bot (obrigatórios)

- `chat:write` (enviar/atualizar/excluir mensagens via `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (abrir DMs via `conversations.open` para DMs de usuário)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (consulta de usuário)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (uploads via `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### Escopos do token de usuário (opcional, somente leitura por padrão)

Adicione estes em **User Token Scopes** se você configurar `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Não necessários hoje (mas prováveis no futuro)

- `mpim:write` (somente se adicionarmos abertura de group-DM/início de DM via `conversations.open`)
- `groups:write` (somente se adicionarmos gerenciamento de canais privados: criar/renomear/convidar/arquivar)
- `chat:write.public` (somente se quisermos postar em canais nos quais o bot não está)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (somente se precisarmos de campos de email de `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (somente se começarmos a listar/ler metadados de arquivos)

## Configuração

O Slack usa apenas o Modo Socket (sem servidor de webhook HTTP). Forneça ambos os tokens:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Os tokens também podem ser fornecidos via variáveis de ambiente:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Reações de confirmação (ack) são controladas globalmente via `messages.ackReaction` +
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` para limpar a
reação de ack após o bot responder.

## Limites

- Texto de saída é fragmentado em `channels.slack.textChunkLimit` (padrão 4000).
- Fragmentação opcional por nova linha: defina `channels.slack.chunkMode="newline"` para dividir em linhas em branco (limites de parágrafo) antes da fragmentação por comprimento.
- Uploads de mídia são limitados por `channels.slack.mediaMaxMb` (padrão 20).

## Encadeamento de respostas

Por padrão, o OpenClaw responde no canal principal. Use `channels.slack.replyToMode` para controlar o encadeamento automático:

| Modo    | Comportamento                                                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`   | **Padrão.** Responder no canal principal. Só cria thread se a mensagem de disparo já estiver em uma thread.                                                                                |
| `first` | A primeira resposta vai para a thread (sob a mensagem de disparo); respostas subsequentes vão para o canal principal. Útil para manter o contexto visível evitando poluição de threads. |
| `all`   | Todas as respostas vão para a thread. Mantém conversas contidas, mas pode reduzir a visibilidade.                                                                                                          |

O modo se aplica tanto a respostas automáticas quanto a chamadas de ferramentas do agente (`slack sendMessage`).

### Encadeamento por tipo de chat

Você pode configurar comportamentos de encadeamento diferentes por tipo de chat definindo `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Tipos de chat suportados:

- `direct`: DMs 1:1 (Slack `im`)
- `group`: DMs em grupo / MPIMs (Slack `mpim`)
- `channel`: canais padrão (públicos/privados)

Precedência:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Padrão do provedor (`off`)

O `channels.slack.dm.replyToMode` legado ainda é aceito como fallback para `direct` quando nenhum override por tipo de chat está definido.

Exemplos:

Criar threads apenas em DMs:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Criar threads em DMs de grupo, mas manter canais na raiz:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Fazer canais usarem thread e manter DMs na raiz:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Tags manuais de encadeamento

Para controle refinado, use estas tags nas respostas do agente:

- `[[reply_to_current]]` — responder à mensagem de disparo (iniciar/continuar thread).
- `[[reply_to:<id>]]` — responder a um ID de mensagem específico.

## Sessões + roteamento

- DMs compartilham a sessão `main` (como WhatsApp/Telegram).
- Canais mapeiam para sessões `agent:<agentId>:slack:channel:<channelId>`.
- Slash commands usam sessões `agent:<agentId>:slack:slash:<userId>` (prefixo configurável via `channels.slack.slashCommand.sessionPrefix`).
- Se o Slack não fornecer `channel_type`, o OpenClaw infere a partir do prefixo do ID do canal (`D`, `C`, `G`) e usa `channel` por padrão para manter chaves de sessão estáveis.
- O registro de comandos nativos usa `commands.native` (padrão global `"auto"` → Slack desativado) e pode ser substituído por workspace com `channels.slack.commands.native`. Comandos de texto exigem mensagens `/...` independentes e podem ser desativados com `commands.text: false`. Slash commands do Slack são gerenciados no app do Slack e não são removidos automaticamente. Use `commands.useAccessGroups: false` para ignorar verificações de grupo de acesso para comandos.
- Lista completa de comandos + configuração: [Slash commands](/tools/slash-commands)

## Segurança de DM (pareamento)

- Padrão: `channels.slack.dm.policy="pairing"` — remetentes desconhecidos em DM recebem um código de pareamento (expira após 1 hora).
- Aprovar via: `openclaw pairing approve slack <code>`.
- Para permitir qualquer pessoa: defina `channels.slack.dm.policy="open"` e `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` aceita IDs de usuário, @handles ou emails (resolvidos na inicialização quando os tokens permitem). O assistente aceita nomes de usuário e os resolve para IDs durante a configuração quando os tokens permitem.

## Política de grupo

- `channels.slack.groupPolicy` controla o tratamento de canais (`open|disabled|allowlist`).
- `allowlist` exige que os canais estejam listados em `channels.slack.channels`.
- Se você definir apenas `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` e nunca criar uma seção `channels.slack`,
  o runtime define `groupPolicy` como `open` por padrão. Adicione `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` ou uma lista de permissões de canais para restringir.
- O assistente de configuração aceita nomes `#channel` e os resolve para IDs quando possível
  (públicos + privados); se existirem múltiplas correspondências, ele prefere o canal ativo.
- Na inicialização, o OpenClaw resolve nomes de canais/usuários em allowlists para IDs (quando os tokens permitem)
  e registra o mapeamento; entradas não resolvidas são mantidas como digitadas.
- Para permitir **nenhum canal**, defina `channels.slack.groupPolicy: "disabled"` (ou mantenha uma allowlist vazia).

Opções de canal (`channels.slack.channels.<id>` ou `channels.slack.channels.<name>`):

- `allow`: permitir/negar o canal quando `groupPolicy="allowlist"`.
- `requireMention`: controle por menção para o canal.
- `tools`: overrides opcionais de política de ferramentas por canal (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: overrides opcionais de política de ferramentas por remetente dentro do canal (as chaves são IDs de remetente/@handles/emails; wildcard `"*"` suportado).
- `allowBots`: permitir mensagens de autoria do bot neste canal (padrão: false).
- `users`: allowlist opcional de usuários por canal.
- `skills`: filtro de skills (omitido = todas as skills, vazio = nenhuma).
- `systemPrompt`: prompt de sistema extra para o canal (combinado com tópico/finalidade).
- `enabled`: defina `false` para desativar o canal.

## Alvos de entrega

Use estes com envios via cron/CLI:

- `user:<id>` para DMs
- `channel:<id>` para canais

## Ações de ferramentas

Ações de ferramentas do Slack podem ser controladas com `channels.slack.actions.*`:

| Grupo de ação | Padrão  | Notas                          |
| ------------- | ------- | ------------------------------ |
| reactions     | enabled | Reagir + listar reações        |
| messages      | enabled | Ler/enviar/editar/excluir      |
| pins          | enabled | Fixar/desafixar/listar         |
| memberInfo    | enabled | Informações de membros         |
| emojiList     | enabled | Lista de emojis personalizados |

## Notas de segurança

- Gravações usam o token do bot por padrão para que ações que alteram estado permaneçam
  escopadas às permissões e identidade do bot do app.
- Definir `userTokenReadOnly: false` permite que o token de usuário seja usado para
  operações de gravação quando um token de bot não estiver disponível, o que significa
  que as ações serão executadas com o acesso do usuário que instalou. Trate o token de usuário
  como altamente privilegiado e mantenha controles e allowlists restritos.
- Se você habilitar gravações com token de usuário, garanta que o token de usuário inclua os escopos de gravação
  esperados (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) ou essas operações falharão.

## Solução de problemas

Execute esta escada primeiro:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Em seguida, confirme o estado de pareamento de DM, se necessário:

```bash
openclaw pairing list slack
```

Falhas comuns:

- Conectado, mas sem respostas em canais: canal bloqueado por `groupPolicy` ou não está na allowlist `channels.slack.channels`.
- DMs ignoradas: remetente não aprovado quando `channels.slack.dm.policy="pairing"`.
- Erros de API (`missing_scope`, `not_in_channel`, falhas de autenticação): tokens de bot/app ou escopos do Slack incompletos.

Para fluxo de triagem: [/channels/troubleshooting](/channels/troubleshooting).

## Notas

- Controle por menção é definido via `channels.slack.channels` (defina `requireMention` como `true`); `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`) também contam como menções.
- Override multiagente: defina padrões por agente em `agents.list[].groupChat.mentionPatterns`.
- Notificações de reação seguem `channels.slack.reactionNotifications` (use `reactionAllowlist` com modo `allowlist`).
- Mensagens de autoria do bot são ignoradas por padrão; habilite via `channels.slack.allowBots` ou `channels.slack.channels.<id>.allowBots`.
- Aviso: Se você permitir respostas a outros bots (`channels.slack.allowBots=true` ou `channels.slack.channels.<id>.allowBots=true`), evite loops de bot-para-bot com allowlists `requireMention`, `channels.slack.channels.<id>.users` e/ou proteções claras em `AGENTS.md` e `SOUL.md`.
- Para a ferramenta do Slack, a semântica de remoção de reações está em [/tools/reactions](/tools/reactions).
- Anexos são baixados para o repositório de mídia quando permitido e abaixo do limite de tamanho.
