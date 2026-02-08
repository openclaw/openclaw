---
summary: "Status de suporte do bot do Telegram, capacidades e configuração"
read_when:
  - Trabalhando em recursos ou webhooks do Telegram
title: "Telegram"
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:04Z
---

# Telegram (Bot API)

Status: pronto para produção para DMs de bots + grupos via grammY. Long-polling por padrão; webhook opcional.

## Configuração rápida (iniciante)

1. Crie um bot com **@BotFather** ([link direto](https://t.me/BotFather)). Confirme que o handle é exatamente `@BotFather`, depois copie o token.
2. Defina o token:
   - Env: `TELEGRAM_BOT_TOKEN=...`
   - Ou config: `channels.telegram.botToken: "..."`.
   - Se ambos estiverem definidos, a config tem precedência (o fallback de env é apenas para a conta padrão).
3. Inicie o gateway.
4. O acesso por DM é pareamento por padrão; aprove o código de pareamento no primeiro contato.

Configuração mínima:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## O que é

- Um canal da API de Bots do Telegram pertencente ao Gateway.
- Roteamento determinístico: as respostas voltam para o Telegram; o modelo nunca escolhe canais.
- DMs compartilham a sessão principal do agente; grupos permanecem isolados (`agent:<agentId>:telegram:group:<chatId>`).

## Configuração (caminho rápido)

### 1) Criar um token de bot (BotFather)

1. Abra o Telegram e converse com **@BotFather** ([link direto](https://t.me/BotFather)). Confirme que o handle é exatamente `@BotFather`.
2. Execute `/newbot`, depois siga as instruções (nome + nome de usuário terminando em `bot`).
3. Copie o token e armazene-o com segurança.

Configurações opcionais do BotFather:

- `/setjoingroups` — permitir/negar adicionar o bot a grupos.
- `/setprivacy` — controlar se o bot vê todas as mensagens do grupo.

### 2) Configurar o token (env ou config)

Exemplo:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Opção via env: `TELEGRAM_BOT_TOKEN=...` (funciona para a conta padrão).
Se env e config estiverem definidos, a config tem precedência.

Suporte a múltiplas contas: use `channels.telegram.accounts` com tokens por conta e `name` opcional. Veja [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para o padrão compartilhado.

3. Inicie o gateway. O Telegram inicia quando um token é resolvido (config primeiro, fallback de env).
4. O acesso por DM é pareado por padrão. Aprove o código quando o bot for contatado pela primeira vez.
5. Para grupos: adicione o bot, decida o comportamento de privacidade/admin (abaixo) e então defina `channels.telegram.groups` para controlar gating por menção + listas de permissões.

## Token + privacidade + permissões (lado do Telegram)

### Criação do token (BotFather)

- `/newbot` cria o bot e retorna o token (mantenha-o em segredo).
- Se um token vazar, revogue/regenere via @BotFather e atualize sua configuração.

### Visibilidade de mensagens em grupos (Modo de Privacidade)

Bots do Telegram usam **Modo de Privacidade** por padrão, o que limita quais mensagens de grupos eles recebem.
Se seu bot precisa ver _todas_ as mensagens do grupo, você tem duas opções:

- Desativar o modo de privacidade com `/setprivacy` **ou**
- Adicionar o bot como **admin** do grupo (bots admin recebem todas as mensagens).

**Nota:** Ao alternar o modo de privacidade, o Telegram exige remover e re-adicionar o bot
a cada grupo para que a alteração tenha efeito.

### Permissões de grupo (direitos de admin)

O status de admin é definido dentro do grupo (UI do Telegram). Bots admin sempre recebem todas
as mensagens do grupo, então use admin se precisar de visibilidade total.

## Como funciona (comportamento)

- Mensagens de entrada são normalizadas no envelope de canal compartilhado com contexto de resposta e placeholders de mídia.
- Respostas em grupos exigem menção por padrão (menção nativa @ ou `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- Substituição multiagente: defina padrões por agente em `agents.list[].groupChat.mentionPatterns`.
- As respostas sempre retornam para o mesmo chat do Telegram.
- Long-polling usa o runner do grammY com sequenciamento por chat; a concorrência geral é limitada por `agents.defaults.maxConcurrent`.
- A API de Bots do Telegram não suporta recibos de leitura; não há opção `sendReadReceipts`.

## Streaming de rascunho

O OpenClaw pode transmitir respostas parciais em DMs do Telegram usando `sendMessageDraft`.

Requisitos:

- Modo Threaded habilitado para o bot no @BotFather (modo de tópico de fórum).
- Apenas threads de chat privado (o Telegram inclui `message_thread_id` nas mensagens de entrada).
- `channels.telegram.streamMode` não definido como `"off"` (padrão: `"partial"`, `"block"` habilita atualizações de rascunho em blocos).

O streaming de rascunho é apenas para DMs; o Telegram não o suporta em grupos ou canais.

## Formatação (HTML do Telegram)

- Texto de saída do Telegram usa `parse_mode: "HTML"` (subconjunto de tags suportadas pelo Telegram).
- Entrada em estilo Markdown é renderizada em **HTML seguro para o Telegram** (negrito/itálico/riscado/código/links); elementos de bloco são achatados em texto com novas linhas/marcadores.
- HTML bruto vindo de modelos é escapado para evitar erros de parsing do Telegram.
- Se o Telegram rejeitar o payload HTML, o OpenClaw tenta novamente a mesma mensagem como texto simples.

## Comandos (nativos + personalizados)

O OpenClaw registra comandos nativos (como `/status`, `/reset`, `/model`) no menu de bots do Telegram na inicialização.
Você pode adicionar comandos personalizados ao menu via config:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

## Solução de problemas de configuração (comandos)

- `setMyCommands failed` nos logs geralmente significa que HTTPS/DNS de saída está bloqueado para `api.telegram.org`.
- Se você vir falhas `sendMessage` ou `sendChatAction`, verifique o roteamento IPv6 e o DNS.

Mais ajuda: [Solução de problemas de canais](/channels/troubleshooting).

Notas:

- Comandos personalizados são **apenas entradas de menu**; o OpenClaw não os implementa a menos que você os trate em outro lugar.
- Os nomes dos comandos são normalizados (prefixo `/` removido, em minúsculas) e devem corresponder a `a-z`, `0-9`, `_` (1–32 caracteres).
- Comandos personalizados **não podem substituir comandos nativos**. Conflitos são ignorados e registrados em log.
- Se `commands.native` estiver desabilitado, apenas comandos personalizados são registrados (ou limpos se não houver).

## Limites

- Texto de saída é dividido em `channels.telegram.textChunkLimit` (padrão 4000).
- Divisão opcional por nova linha: defina `channels.telegram.chunkMode="newline"` para dividir em linhas em branco (limites de parágrafo) antes da divisão por comprimento.
- Downloads/uploads de mídia são limitados por `channels.telegram.mediaMaxMb` (padrão 5).
- Requisições da API de Bots do Telegram expiram após `channels.telegram.timeoutSeconds` (padrão 500 via grammY). Defina menor para evitar travamentos longos.
- Contexto do histórico do grupo usa `channels.telegram.historyLimit` (ou `channels.telegram.accounts.*.historyLimit`), com fallback para `messages.groupChat.historyLimit`. Defina `0` para desabilitar (padrão 50).
- O histórico de DM pode ser limitado com `channels.telegram.dmHistoryLimit` (turnos do usuário). Substituições por usuário: `channels.telegram.dms["<user_id>"].historyLimit`.

## Modos de ativação em grupos

Por padrão, o bot só responde a menções em grupos (`@botname` ou padrões em `agents.list[].groupChat.mentionPatterns`). Para alterar esse comportamento:

### Via config (recomendado)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**Importante:** Definir `channels.telegram.groups` cria uma **lista de permissões** — apenas os grupos listados (ou `"*"`) serão aceitos.
Tópicos de fórum herdam a configuração do grupo pai (allowFrom, requireMention, skills, prompts), a menos que você adicione substituições por tópico em `channels.telegram.groups.<groupId>.topics.<topicId>`.

Para permitir todos os grupos com sempre-responder:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

Para manter apenas menção para todos os grupos (comportamento padrão):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### Via comando (nível de sessão)

Envie no grupo:

- `/activation always` - responder a todas as mensagens
- `/activation mention` - exigir menções (padrão)

**Nota:** Comandos atualizam apenas o estado da sessão. Para comportamento persistente após reinicializações, use config.

### Obtendo o ID do chat do grupo

Encaminhe qualquer mensagem do grupo para `@userinfobot` ou `@getidsbot` no Telegram para ver o ID do chat (número negativo como `-1001234567890`).

**Dica:** Para seu próprio ID de usuário, envie DM ao bot e ele responderá com seu ID de usuário (mensagem de pareamento), ou use `/whoami` quando os comandos estiverem habilitados.

**Nota de privacidade:** `@userinfobot` é um bot de terceiros. Se preferir, adicione o bot ao grupo, envie uma mensagem e use `openclaw logs --follow` para ler `chat.id`, ou use a API de Bots `getUpdates`.

## Escritas de configuração

Por padrão, o Telegram tem permissão para gravar atualizações de configuração acionadas por eventos do canal ou `/config set|unset`.

Isso acontece quando:

- Um grupo é atualizado para supergrupo e o Telegram emite `migrate_to_chat_id` (o ID do chat muda). O OpenClaw pode migrar `channels.telegram.groups` automaticamente.
- Você executa `/config set` ou `/config unset` em um chat do Telegram (requer `commands.config: true`).

Desabilite com:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## Tópicos (supergrupos de fórum)

Tópicos de fórum do Telegram incluem um `message_thread_id` por mensagem. O OpenClaw:

- Anexa `:topic:<threadId>` à chave de sessão do grupo do Telegram para que cada tópico fique isolado.
- Envia indicadores de digitação e respostas com `message_thread_id` para que as respostas permaneçam no tópico.
- O tópico geral (thread id `1`) é especial: envios de mensagens omitem `message_thread_id` (o Telegram rejeita), mas indicadores de digitação ainda o incluem.
- Expõe `MessageThreadId` + `IsForum` no contexto de template para roteamento/templating.
- Configuração específica por tópico está disponível em `channels.telegram.groups.<chatId>.topics.<threadId>` (skills, listas de permissões, resposta automática, prompts do sistema, desabilitar).
- Configurações de tópico herdam as do grupo (requireMention, listas de permissões, skills, prompts, habilitado) a menos que sejam substituídas por tópico.

Chats privados podem incluir `message_thread_id` em alguns casos extremos. O OpenClaw mantém a chave de sessão de DM inalterada, mas ainda usa o thread id para respostas/streaming de rascunho quando presente.

## Botões Inline

O Telegram suporta teclados inline com botões de callback.

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

Para configuração por conta:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

Escopos:

- `off` — botões inline desabilitados
- `dm` — apenas DMs (alvos de grupo bloqueados)
- `group` — apenas grupos (alvos de DM bloqueados)
- `all` — DMs + grupos
- `allowlist` — DMs + grupos, mas apenas remetentes permitidos por `allowFrom`/`groupAllowFrom` (mesmas regras que comandos de controle)

Padrão: `allowlist`.
Legado: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### Envio de botões

Use a ferramenta de mensagens com o parâmetro `buttons`:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

Quando um usuário clica em um botão, os dados de callback são enviados de volta ao agente como uma mensagem no formato:
`callback_data: value`

### Opções de configuração

As capacidades do Telegram podem ser configuradas em dois níveis (forma de objeto mostrada acima; arrays de strings legadas ainda são suportadas):

- `channels.telegram.capabilities`: Configuração de capacidade padrão global aplicada a todas as contas do Telegram, a menos que seja substituída.
- `channels.telegram.accounts.<account>.capabilities`: Capacidades por conta que substituem os padrões globais para aquela conta específica.

Use a configuração global quando todos os bots/contas do Telegram devem se comportar da mesma forma. Use a configuração por conta quando bots diferentes precisam de comportamentos diferentes (por exemplo, uma conta só lida com DMs enquanto outra é permitida em grupos).

## Controle de acesso (DMs + grupos)

### Acesso por DM

- Padrão: `channels.telegram.dmPolicy = "pairing"`. Remetentes desconhecidos recebem um código de pareamento; mensagens são ignoradas até a aprovação (códigos expiram após 1 hora).
- Aprovar via:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- O pareamento é a troca de token padrão usada para DMs do Telegram. Detalhes: [Pareamento](/channels/pairing)
- `channels.telegram.allowFrom` aceita IDs numéricos de usuário (recomendado) ou entradas `@username`. **Não** é o nome de usuário do bot; use o ID do remetente humano. O assistente aceita `@username` e resolve para o ID numérico quando possível.

#### Encontrando seu ID de usuário do Telegram

Mais seguro (sem bot de terceiros):

1. Inicie o gateway e envie DM ao seu bot.
2. Execute `openclaw logs --follow` e procure `from.id`.

Alternativo (API oficial de Bots):

1. Envie DM ao seu bot.
2. Busque atualizações com o token do bot e leia `message.from.id`:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

Terceiros (menos privado):

- Envie DM para `@userinfobot` ou `@getidsbot` e use o ID de usuário retornado.

### Acesso a grupos

Dois controles independentes:

**1. Quais grupos são permitidos** (lista de permissões de grupos via `channels.telegram.groups`):

- Sem config `groups` = todos os grupos permitidos
- Com config `groups` = apenas os grupos listados ou `"*"` são permitidos
- Exemplo: `"groups": { "-1001234567890": {}, "*": {} }` permite todos os grupos

**2. Quais remetentes são permitidos** (filtragem de remetentes via `channels.telegram.groupPolicy`):

- `"open"` = todos os remetentes em grupos permitidos podem enviar mensagens
- `"allowlist"` = apenas remetentes em `channels.telegram.groupAllowFrom` podem enviar mensagens
- `"disabled"` = nenhuma mensagem de grupo é aceita
  O padrão é `groupPolicy: "allowlist"` (bloqueado a menos que você adicione `groupAllowFrom`).

A maioria dos usuários quer: `groupPolicy: "allowlist"` + `groupAllowFrom` + grupos específicos listados em `channels.telegram.groups`

Para permitir que **qualquer membro do grupo** fale em um grupo específico (mantendo comandos de controle restritos a remetentes autorizados), defina uma substituição por grupo:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

## Long-polling vs webhook

- Padrão: long-polling (nenhuma URL pública necessária).
- Modo webhook: defina `channels.telegram.webhookUrl` e `channels.telegram.webhookSecret` (opcionalmente `channels.telegram.webhookPath`).
  - O listener local se liga a `0.0.0.0:8787` e serve `POST /telegram-webhook` por padrão.
  - Se sua URL pública for diferente, use um proxy reverso e aponte `channels.telegram.webhookUrl` para o endpoint público.

## Encadeamento de respostas

O Telegram suporta respostas encadeadas opcionais via tags:

- `[[reply_to_current]]` -- responder à mensagem disparadora.
- `[[reply_to:<id>]]` -- responder a um ID de mensagem específico.

Controlado por `channels.telegram.replyToMode`:

- `first` (padrão), `all`, `off`.

## Mensagens de áudio (voz vs arquivo)

O Telegram distingue **notas de voz** (bolha redonda) de **arquivos de áudio** (cartão com metadados).
O OpenClaw usa arquivos de áudio por padrão para compatibilidade retroativa.

Para forçar uma bolha de nota de voz nas respostas do agente, inclua esta tag em qualquer lugar da resposta:

- `[[audio_as_voice]]` — enviar áudio como nota de voz em vez de arquivo.

A tag é removida do texto entregue. Outros canais ignoram essa tag.

Para envios via ferramenta de mensagens, defina `asVoice: true` com um `media` de áudio compatível com voz
(`message` é opcional quando há mídia):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## Figurinhas (Stickers)

O OpenClaw oferece suporte a receber e enviar figurinhas do Telegram com cache inteligente.

### Recebendo figurinhas

Quando um usuário envia uma figurinha, o OpenClaw a trata com base no tipo de figurinha:

- **Figurinhas estáticas (WEBP):** Baixadas e processadas via visão. A figurinha aparece como um placeholder `<media:sticker>` no conteúdo da mensagem.
- **Figurinhas animadas (TGS):** Ignoradas (formato Lottie não suportado para processamento).
- **Figurinhas de vídeo (WEBM):** Ignoradas (formato de vídeo não suportado para processamento).

Campo de contexto de template disponível ao receber figurinhas:

- `Sticker` — objeto com:
  - `emoji` — emoji associado à figurinha
  - `setName` — nome do conjunto de figurinhas
  - `fileId` — ID de arquivo do Telegram (enviar a mesma figurinha de volta)
  - `fileUniqueId` — ID estável para consulta no cache
  - `cachedDescription` — descrição de visão em cache quando disponível

### Cache de figurinhas

As figurinhas são processadas pelas capacidades de visão da IA para gerar descrições. Como as mesmas figurinhas são frequentemente enviadas repetidamente, o OpenClaw armazena essas descrições em cache para evitar chamadas redundantes à API.

**Como funciona:**

1. **Primeiro encontro:** A imagem da figurinha é enviada à IA para análise de visão. A IA gera uma descrição (por exemplo, "Um gato de desenho animado acenando entusiasticamente").
2. **Armazenamento em cache:** A descrição é salva junto com o ID do arquivo da figurinha, emoji e nome do conjunto.
3. **Encontros subsequentes:** Quando a mesma figurinha aparece novamente, a descrição em cache é usada diretamente. A imagem não é enviada à IA.

**Local do cache:** `~/.openclaw/telegram/sticker-cache.json`

**Formato da entrada do cache:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**Benefícios:**

- Reduz custos de API ao evitar chamadas de visão repetidas para a mesma figurinha
- Tempos de resposta mais rápidos para figurinhas em cache (sem atraso de processamento de visão)
- Permite funcionalidade de busca de figurinhas com base em descrições em cache

O cache é populado automaticamente conforme as figurinhas são recebidas. Não há gerenciamento manual de cache necessário.

### Enviando figurinhas

O agente pode enviar e buscar figurinhas usando as ações `sticker` e `sticker-search`. Elas são desabilitadas por padrão e devem ser habilitadas na config:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

**Enviar uma figurinha:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

Parâmetros:

- `fileId` (obrigatório) — o ID de arquivo do Telegram da figurinha. Obtenha isso a partir de `Sticker.fileId` ao receber uma figurinha, ou de um resultado de `sticker-search`.
- `replyTo` (opcional) — ID da mensagem à qual responder.
- `threadId` (opcional) — ID do tópico de mensagem para tópicos de fórum.

**Buscar figurinhas:**

O agente pode buscar figurinhas em cache por descrição, emoji ou nome do conjunto:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

Retorna figurinhas correspondentes do cache:

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

A busca usa correspondência fuzzy em texto de descrição, caracteres de emoji e nomes de conjuntos.

**Exemplo com encadeamento:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## Streaming (rascunhos)

O Telegram pode transmitir **bolhas de rascunho** enquanto o agente está gerando uma resposta.
O OpenClaw usa a API de Bots `sendMessageDraft` (não são mensagens reais) e depois envia a
resposta final como uma mensagem normal.

Requisitos (API de Bots do Telegram 9.3+):

- **Chats privados com tópicos habilitados** (modo de tópico de fórum para o bot).
- Mensagens de entrada devem incluir `message_thread_id` (thread de tópico privado).
- O streaming é ignorado para grupos/supergrupos/canais.

Configuração:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (padrão: `partial`)
  - `partial`: atualizar a bolha de rascunho com o texto de streaming mais recente.
  - `block`: atualizar a bolha de rascunho em blocos maiores (em partes).
  - `off`: desabilitar o streaming de rascunho.
- Opcional (apenas para `streamMode: "block"`):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - padrões: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (limitados a `channels.telegram.textChunkLimit`).

Nota: o streaming de rascunho é separado do **streaming em blocos** (mensagens do canal).
O streaming em blocos vem desabilitado por padrão e requer `channels.telegram.blockStreaming: true`
se você quiser mensagens antecipadas do Telegram em vez de atualizações de rascunho.

Stream de raciocínio (somente Telegram):

- `/reasoning stream` transmite o raciocínio para a bolha de rascunho enquanto a resposta é
  gerada, depois envia a resposta final sem o raciocínio.
- Se `channels.telegram.streamMode` for `off`, o stream de raciocínio é desabilitado.
  Mais contexto: [Streaming + divisão em partes](/concepts/streaming).

## Política de tentativas

Chamadas de saída à API do Telegram repetem em erros transitórios/rede/429 com backoff exponencial e jitter. Configure via `channels.telegram.retry`. Veja [Política de tentativas](/concepts/retry).

## Ferramenta do agente (mensagens + reações)

- Ferramenta: `telegram` com ação `sendMessage` (`to`, `content`, opcional `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Ferramenta: `telegram` com ação `react` (`chatId`, `messageId`, `emoji`).
- Ferramenta: `telegram` com ação `deleteMessage` (`chatId`, `messageId`).
- Semântica de remoção de reações: veja [/tools/reactions](/tools/reactions).
- Gateamento de ferramentas: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (padrão: habilitado) e `channels.telegram.actions.sticker` (padrão: desabilitado).

## Notificações de reações

**Como as reações funcionam:**
Reações do Telegram chegam como **eventos `message_reaction` separados**, não como propriedades no payload da mensagem. Quando um usuário adiciona uma reação, o OpenClaw:

1. Recebe a atualização `message_reaction` da API do Telegram
2. Converte para um **evento de sistema** com o formato: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. Enfileira o evento de sistema usando a **mesma chave de sessão** das mensagens regulares
4. Quando a próxima mensagem chega nessa conversa, os eventos de sistema são drenados e prefixados ao contexto do agente

O agente vê reações como **notificações de sistema** no histórico da conversa, não como metadados da mensagem.

**Configuração:**

- `channels.telegram.reactionNotifications`: Controla quais reações disparam notificações
  - `"off"` — ignorar todas as reações
  - `"own"` — notificar quando usuários reagem a mensagens do bot (best-effort; em memória) (padrão)
  - `"all"` — notificar todas as reações

- `channels.telegram.reactionLevel`: Controla a capacidade de reação do agente
  - `"off"` — o agente não pode reagir a mensagens
  - `"ack"` — o bot envia reações de confirmação (👀 enquanto processa) (padrão)
  - `"minimal"` — o agente pode reagir com parcimônia (diretriz: 1 a cada 5–10 trocas)
  - `"extensive"` — o agente pode reagir liberalmente quando apropriado

**Grupos de fórum:** Reações em grupos de fórum incluem `message_thread_id` e usam chaves de sessão como `agent:main:telegram:group:{chatId}:topic:{threadId}`. Isso garante que reações e mensagens no mesmo tópico permaneçam juntas.

**Exemplo de config:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**Requisitos:**

- Bots do Telegram devem solicitar explicitamente `message_reaction` em `allowed_updates` (configurado automaticamente pelo OpenClaw)
- No modo webhook, reações são incluídas no webhook `allowed_updates`
- No modo polling, reações são incluídas nas `getUpdates` `allowed_updates`

## Destinos de entrega (CLI/cron)

- Use um chat id (`123456789`) ou um nome de usuário (`@name`) como destino.
- Exemplo: `openclaw message send --channel telegram --target 123456789 --message "hi"`.

## Solução de problemas

**O bot não responde a mensagens sem menção em um grupo:**

- Se você definiu `channels.telegram.groups.*.requireMention=false`, o **modo de privacidade** da API de Bots do Telegram deve estar desabilitado.
  - BotFather: `/setprivacy` → **Disable** (depois remova e re-adicione o bot ao grupo)
- `openclaw channels status` mostra um aviso quando a config espera mensagens de grupo sem menção.
- `openclaw channels status --probe` pode verificar adicionalmente a associação para IDs numéricos explícitos de grupos (não consegue auditar regras curinga `"*"`).
- Teste rápido: `/activation always` (apenas sessão; use config para persistência)

**O bot não vê mensagens de grupo de forma alguma:**

- Se `channels.telegram.groups` estiver definido, o grupo deve estar listado ou usar `"*"`
- Verifique Configurações de Privacidade no @BotFather → "Group Privacy" deve estar **OFF**
- Verifique se o bot é realmente membro (não apenas admin sem acesso de leitura)
- Verifique os logs do gateway: `openclaw logs --follow` (procure por "skipping group message")

**O bot responde a menções, mas não a `/activation always`:**

- O comando `/activation` atualiza o estado da sessão, mas não persiste na config
- Para comportamento persistente, adicione o grupo a `channels.telegram.groups` com `requireMention: false`

**Comandos como `/status` não funcionam:**

- Certifique-se de que seu ID de usuário do Telegram esteja autorizado (via pareamento ou `channels.telegram.allowFrom`)
- Comandos exigem autorização mesmo em grupos com `groupPolicy: "open"`

**O long-polling é abortado imediatamente no Node 22+ (frequentemente com proxies/fetch customizado):**

- O Node 22+ é mais rigoroso com instâncias `AbortSignal`; sinais externos podem abortar chamadas `fetch` imediatamente.
- Atualize para uma build do OpenClaw que normalize sinais de abort, ou execute o gateway no Node 20 até poder atualizar.

**O bot inicia e depois para silenciosamente de responder (ou registra `HttpError: Network request ... failed`):**

- Alguns hosts resolvem `api.telegram.org` para IPv6 primeiro. Se seu servidor não tiver saída IPv6 funcional, o grammY pode travar em requisições apenas IPv6.
- Corrija habilitando saída IPv6 **ou** forçando resolução IPv4 para `api.telegram.org` (por exemplo, adicione uma entrada `/etc/hosts` usando o registro A IPv4, ou prefira IPv4 na pilha DNS do SO), depois reinicie o gateway.
- Verificação rápida: `dig +short api.telegram.org A` e `dig +short api.telegram.org AAAA` para confirmar o que o DNS retorna.

## Referência de configuração (Telegram)

Configuração completa: [Configuração](/gateway/configuration)

Opções do provedor:

- `channels.telegram.enabled`: habilitar/desabilitar a inicialização do canal.
- `channels.telegram.botToken`: token do bot (BotFather).
- `channels.telegram.tokenFile`: ler token de um caminho de arquivo.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (padrão: pareamento).
- `channels.telegram.allowFrom`: lista de permissões de DM (ids/usernames). `open` requer `"*"`.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (padrão: lista de permissões).
- `channels.telegram.groupAllowFrom`: lista de permissões de remetentes de grupo (ids/usernames).
- `channels.telegram.groups`: padrões por grupo + lista de permissões (use `"*"` para padrões globais).
  - `channels.telegram.groups.<id>.groupPolicy`: substituição por grupo para groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: padrão de gating por menção.
  - `channels.telegram.groups.<id>.skills`: filtro de skills (omitir = todas as skills, vazio = nenhuma).
  - `channels.telegram.groups.<id>.allowFrom`: substituição da lista de permissões de remetentes por grupo.
  - `channels.telegram.groups.<id>.systemPrompt`: prompt de sistema extra para o grupo.
  - `channels.telegram.groups.<id>.enabled`: desabilitar o grupo quando `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: substituições por tópico (mesmos campos do grupo).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: substituição por tópico para groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: substituição de gating por menção por tópico.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (padrão: lista de permissões).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: substituição por conta.
- `channels.telegram.replyToMode`: `off | first | all` (padrão: `first`).
- `channels.telegram.textChunkLimit`: tamanho de divisão de saída (caracteres).
- `channels.telegram.chunkMode`: `length` (padrão) ou `newline` para dividir em linhas em branco (limites de parágrafo) antes da divisão por comprimento.
- `channels.telegram.linkPreview`: alternar prévias de links para mensagens de saída (padrão: true).
- `channels.telegram.streamMode`: `off | partial | block` (streaming de rascunho).
- `channels.telegram.mediaMaxMb`: limite de mídia de entrada/saída (MB).
- `channels.telegram.retry`: política de tentativas para chamadas de saída da API do Telegram (tentativas, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: substituir autoSelectFamily do Node (true=habilitar, false=desabilitar). Padrão desabilitado no Node 22 para evitar timeouts do Happy Eyeballs.
- `channels.telegram.proxy`: URL de proxy para chamadas da API de Bots (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: habilitar modo webhook (requer `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: segredo do webhook (obrigatório quando webhookUrl está definido).
- `channels.telegram.webhookPath`: caminho local do webhook (padrão `/telegram-webhook`).
- `channels.telegram.actions.reactions`: gatear reações da ferramenta do Telegram.
- `channels.telegram.actions.sendMessage`: gatear envios de mensagens da ferramenta do Telegram.
- `channels.telegram.actions.deleteMessage`: gatear exclusões de mensagens da ferramenta do Telegram.
- `channels.telegram.actions.sticker`: gatear ações de figurinhas do Telegram — enviar e buscar (padrão: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — controlar quais reações disparam eventos de sistema (padrão: `own` quando não definido).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — controlar a capacidade de reação do agente (padrão: `minimal` quando não definido).

Opções globais relacionadas:

- `agents.list[].groupChat.mentionPatterns` (padrões de gating por menção).
- `messages.groupChat.mentionPatterns` (fallback global).
- `commands.native` (padrão para `"auto"` → ligado para Telegram/Discord, desligado para Slack), `commands.text`, `commands.useAccessGroups` (comportamento de comandos). Substitua com `channels.telegram.commands.native`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
