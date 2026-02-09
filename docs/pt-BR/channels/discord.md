---
summary: "Status de suporte do bot do Discord, capacidades e configuração"
read_when:
  - Trabalhando em recursos do canal Discord
title: "Discord"
---

# Discord (API de Bot)

Status: pronto para DMs e canais de texto de guilda via o gateway oficial de bot do Discord.

## Configuração rápida (iniciante)

1. Crie um bot do Discord e copie o token do bot.
2. Nas configurações do aplicativo Discord, ative **Message Content Intent** (e **Server Members Intent** se você pretende usar listas de permissões ou consultas por nome).
3. Defina o token para o OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Ou config: `channels.discord.token: "..."`.
   - Se ambos estiverem definidos, a config tem precedência (o fallback por env é apenas para a conta padrão).
4. Convide o bot para seu servidor com permissões de mensagem (crie um servidor privado se você quiser apenas DMs).
5. Inicie o gateway.
6. O acesso por DM é emparelhado por padrão; aprove o código de emparelhamento no primeiro contato.

Configuração mínima:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Objetivos

- Conversar com o OpenClaw via DMs do Discord ou canais de guilda.
- Chats diretos são consolidados na sessão principal do agente (padrão `agent:main:main`); canais de guilda permanecem isolados como `agent:<agentId>:discord:channel:<channelId>` (nomes de exibição usam `discord:<guildSlug>#<channelSlug>`).
- DMs em grupo são ignoradas por padrão; ative via `channels.discord.dm.groupEnabled` e, opcionalmente, restrinja por `channels.discord.dm.groupChannels`.
- Manter o roteamento determinístico: as respostas sempre retornam ao canal de onde chegaram.

## Como funciona

1. Crie um aplicativo do Discord → Bot, ative os intents necessários (DMs + mensagens de guilda + conteúdo de mensagens) e pegue o token do bot.
2. Convide o bot para seu servidor com as permissões necessárias para ler/enviar mensagens onde você quiser usá-lo.
3. Configure o OpenClaw com `channels.discord.token` (ou `DISCORD_BOT_TOKEN` como fallback).
4. Execute o gateway; ele inicia automaticamente o canal do Discord quando um token está disponível (config primeiro, fallback por env) e `channels.discord.enabled` não é `false`.
   - Se você preferir variáveis de ambiente, defina `DISCORD_BOT_TOKEN` (um bloco de configuração é opcional).
5. Chats diretos: use `user:<id>` (ou uma menção `<@id>`) ao entregar; todas as interações caem na sessão compartilhada `main`. IDs numéricos simples são ambíguos e rejeitados.
6. Canais de guilda: use `channel:<channelId>` para entrega. Menções são exigidas por padrão e podem ser definidas por guilda ou por canal.
7. Chats diretos: seguros por padrão via `channels.discord.dm.policy` (padrão: `"pairing"`). Remetentes desconhecidos recebem um código de emparelhamento (expira após 1 hora); aprove via `openclaw pairing approve discord <code>`.
   - Para manter o comportamento antigo de “aberto a qualquer um”: defina `channels.discord.dm.policy="open"` e `channels.discord.dm.allowFrom=["*"]`.
   - Para lista de permissões rígida: defina `channels.discord.dm.policy="allowlist"` e liste os remetentes em `channels.discord.dm.allowFrom`.
   - Para ignorar todas as DMs: defina `channels.discord.dm.enabled=false` ou `channels.discord.dm.policy="disabled"`.
8. DMs em grupo são ignoradas por padrão; ative via `channels.discord.dm.groupEnabled` e, opcionalmente, restrinja por `channels.discord.dm.groupChannels`.
9. Regras opcionais de guilda: defina `channels.discord.guilds` com chave por id da guilda (preferido) ou slug, com regras por canal.
10. Comandos nativos opcionais: `commands.native` tem padrão `"auto"` (ativado para Discord/Telegram, desativado para Slack). Substitua com `channels.discord.commands.native: true|false|"auto"`; `false` limpa comandos registrados anteriormente. Comandos de texto são controlados por `commands.text` e devem ser enviados como mensagens `/...` independentes. Use `commands.useAccessGroups: false` para ignorar verificações de grupo de acesso para comandos.
    - Lista completa de comandos + config: [Slash commands](/tools/slash-commands)
11. Histórico de contexto opcional de guilda: defina `channels.discord.historyLimit` (padrão 20, fallback para `messages.groupChat.historyLimit`) para incluir as últimas N mensagens da guilda como contexto ao responder a uma menção. Defina `0` para desativar.
12. Reações: o agente pode acionar reações via a ferramenta `discord` (controlada por `channels.discord.actions.*`).
    - Semântica de remoção de reações: veja [/tools/reactions](/tools/reactions).
    - A ferramenta `discord` só é exposta quando o canal atual é Discord.
13. Comandos nativos usam chaves de sessão isoladas (`agent:<agentId>:discord:slash:<userId>`) em vez da sessão compartilhada `main`.

Nota: A resolução de nome → id usa a busca de membros da guilda e requer Server Members Intent; se o bot não puder pesquisar membros, use ids ou menções `<@id>`.
Nota: Slugs são em minúsculas com espaços substituídos por `-`. Nomes de canais são transformados em slug sem o prefixo `#`.
Nota: Linhas de contexto de guilda `[from:]` incluem `author.tag` + `id` para facilitar respostas prontas para ping.

## Escritas de configuração

Por padrão, o Discord tem permissão para escrever atualizações de configuração acionadas por `/config set|unset` (requer `commands.config: true`).

Desative com:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Como criar seu próprio bot

Este é o setup do “Discord Developer Portal” para executar o OpenClaw em um canal de servidor (guilda) como `#help`.

### 1. Criar o app do Discord + usuário do bot

1. Discord Developer Portal → **Applications** → **New Application**
2. No seu app:
   - **Bot** → **Add Bot**
   - Copie o **Bot Token** (é isso que você coloca em `DISCORD_BOT_TOKEN`)

### 2) Ativar os gateway intents necessários para o OpenClaw

O Discord bloqueia “intents privilegiados” a menos que você os ative explicitamente.

Em **Bot** → **Privileged Gateway Intents**, ative:

- **Message Content Intent** (necessário para ler o texto das mensagens na maioria das guildas; sem ele você verá “Used disallowed intents” ou o bot conectará mas não reagirá às mensagens)
- **Server Members Intent** (recomendado; necessário para algumas consultas de membros/usuários e correspondência de listas de permissões em guildas)

Normalmente você **não** precisa do **Presence Intent**. Definir a presença do próprio bot (ação `setPresence`) usa o gateway OP3 e não requer esse intent; ele só é necessário se você quiser receber atualizações de presença de outros membros da guilda.

### 3. Gerar uma URL de convite (OAuth2 URL Generator)

No seu app: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (necessário para comandos nativos)

**Permissões do Bot** (baseline mínimo)

- ✅ Ver canais
- ✅ Enviar mensagens
- ✅ Ler histórico de mensagens
- ✅ Incorporar links
- ✅ Anexar arquivos
- ✅ Adicionar reações (opcional, mas recomendado)
- ✅ Usar emojis/stickers externos (opcional; apenas se você quiser)

Evite **Administrator** a menos que esteja depurando e confie totalmente no bot.

Copie a URL gerada, abra-a, escolha seu servidor e instale o bot.

### 4. Obter os ids (guilda/usuário/canal)

O Discord usa ids numéricos em tudo; a configuração do OpenClaw prefere ids.

1. Discord (desktop/web) → **User Settings** → **Advanced** → ative **Developer Mode**
2. Clique com o botão direito:
   - Nome do servidor → **Copy Server ID** (id da guilda)
   - Canal (ex.: `#help`) → **Copy Channel ID**
   - Seu usuário → **Copy User ID**

### 5) Configurar o OpenClaw

#### Token

Defina o token do bot via variável de ambiente (recomendado em servidores):

- `DISCORD_BOT_TOKEN=...`

Ou via config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Suporte a múltiplas contas: use `channels.discord.accounts` com tokens por conta e `name` opcional. Veja [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para o padrão compartilhado.

#### Lista de permissões + roteamento de canais

Exemplo “servidor único, permitir apenas eu, permitir apenas #help”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Notas:

- `requireMention: true` significa que o bot só responde quando mencionado (recomendado para canais compartilhados).
- `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`) também contam como menções para mensagens de guilda.
- Substituição multiagente: defina padrões por agente em `agents.list[].groupChat.mentionPatterns`.
- Se `channels` estiver presente, qualquer canal não listado é negado por padrão.
- Use uma entrada de canal `"*"` para aplicar padrões a todos os canais; entradas explícitas de canal substituem o curinga.
- Tópicos herdam a configuração do canal pai (lista de permissões, `requireMention`, skills, prompts, etc.) a menos que você adicione explicitamente o id do canal do tópico.
- Dica de proprietário: quando uma lista de permissões `users` por guilda ou por canal corresponde ao remetente, o OpenClaw trata esse remetente como o proprietário no prompt do sistema. Para um proprietário global entre canais, defina `commands.ownerAllowFrom`.
- Mensagens escritas pelo bot são ignoradas por padrão; defina `channels.discord.allowBots=true` para permiti-las (as próprias mensagens continuam filtradas).
- Aviso: se você permitir respostas a outros bots (`channels.discord.allowBots=true`), evite loops de bot-para-bot com listas de permissões `requireMention`, `channels.discord.guilds.*.channels.<id>.users` e/ou limpe os guardrails em `AGENTS.md` e `SOUL.md`.

### 6. Verificar se funciona

1. Inicie o gateway.
2. No canal do seu servidor, envie: `@Krill hello` (ou o nome do seu bot).
3. Se nada acontecer: verifique **Solução de problemas** abaixo.

### Solução de problemas

- Primeiro: execute `openclaw doctor` e `openclaw channels status --probe` (avisos acionáveis + auditorias rápidas).
- **“Used disallowed intents”**: ative **Message Content Intent** (e provavelmente **Server Members Intent**) no Developer Portal e reinicie o gateway.
- **O bot conecta mas nunca responde em um canal de guilda**:
  - Falta **Message Content Intent**, ou
  - O bot não tem permissões no canal (Ver/Enviar/Ler histórico), ou
  - Sua configuração exige menções e você não mencionou, ou
  - Sua lista de permissões da guilda/canal nega o canal/usuário.
- **`requireMention: false` mas ainda sem respostas**:
- `channels.discord.groupPolicy` tem padrão **allowlist**; defina como `"open"` ou adicione uma entrada de guilda em `channels.discord.guilds` (opcionalmente liste canais em `channels.discord.guilds.<id>.channels` para restringir).
  - Se você definir apenas `DISCORD_BOT_TOKEN` e nunca criar uma seção `channels.discord`, o runtime
    define `groupPolicy` como `open`. Adicione `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy` ou uma lista de permissões de guilda/canal para restringir.
- `requireMention` deve ficar sob `channels.discord.guilds` (ou um canal específico). `channels.discord.requireMention` no nível superior é ignorado.
- **Auditorias de permissões** (`channels status --probe`) verificam apenas IDs numéricos de canal. Se você usar slugs/nomes como chaves `channels.discord.guilds.*.channels`, a auditoria não consegue verificar permissões.
- **DMs não funcionam**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, ou você ainda não foi aprovado (`channels.discord.dm.policy="pairing"`).
- **Aprovações de exec no Discord**: o Discord oferece uma **UI de botões** para aprovações de exec em DMs (Permitir uma vez / Sempre permitir / Negar). `/approve <id> ...` é apenas para aprovações encaminhadas e não resolve os prompts de botões do Discord. Se você vir `❌ Failed to submit approval: Error: unknown approval id` ou a UI nunca aparecer, verifique:
  - `channels.discord.execApprovals.enabled: true` na sua configuração.
  - Seu ID de usuário do Discord está listado em `channels.discord.execApprovals.approvers` (a UI é enviada apenas para aprovadores).
  - Use os botões no prompt de DM (**Permitir uma vez**, **Sempre permitir**, **Negar**).
  - Veja [Exec approvals](/tools/exec-approvals) e [Slash commands](/tools/slash-commands) para o fluxo mais amplo de aprovações e comandos.

## Capacidades e limites

- DMs e canais de texto de guilda (tópicos são tratados como canais separados; voz não suportada).
- Indicadores de digitação enviados no melhor esforço; o fracionamento de mensagens usa `channels.discord.textChunkLimit` (padrão 2000) e divide respostas longas por contagem de linhas (`channels.discord.maxLinesPerMessage`, padrão 17).
- Fracionamento opcional por nova linha: defina `channels.discord.chunkMode="newline"` para dividir em linhas em branco (limites de parágrafo) antes do fracionamento por tamanho.
- Uploads de arquivos suportados até o `channels.discord.mediaMaxMb` configurado (padrão 8 MB).
- Respostas em guilda controladas por menção por padrão para evitar bots ruidosos.
- O contexto de resposta é injetado quando uma mensagem referencia outra mensagem (conteúdo citado + ids).
- Encadeamento nativo de respostas é **desativado por padrão**; ative com `channels.discord.replyToMode` e tags de resposta.

## Política de retry

Chamadas de saída da API do Discord fazem retry em limites de taxa (429) usando `retry_after` do Discord quando disponível, com backoff exponencial e jitter. Configure via `channels.discord.retry`. Veja [Retry policy](/concepts/retry).

## Configuração

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Reações de ack são controladas globalmente via `messages.ackReaction` +
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` para limpar a
reação de ack após o bot responder.

- `dm.enabled`: defina `false` para ignorar todas as DMs (padrão `true`).
- `dm.policy`: controle de acesso a DMs (`pairing` recomendado). `"open"` requer `dm.allowFrom=["*"]`.
- `dm.allowFrom`: lista de permissões de DM (ids de usuário ou nomes). Usada por `dm.policy="allowlist"` e para validação `dm.policy="open"`. O assistente aceita nomes de usuário e os resolve para ids quando o bot consegue pesquisar membros.
- `dm.groupEnabled`: ativar DMs em grupo (padrão `false`).
- `dm.groupChannels`: lista de permissões opcional para ids ou slugs de canais de DM em grupo.
- `groupPolicy`: controla o tratamento de canais de guilda (`open|disabled|allowlist`); `allowlist` requer listas de permissões de canal.
- `guilds`: regras por guilda com chave por id da guilda (preferido) ou slug.
- `guilds."*"`: configurações padrão por guilda aplicadas quando não existe entrada explícita.
- `guilds.<id>.slug`: slug amigável opcional usado para nomes de exibição.
- `guilds.<id>.users`: lista de permissões opcional de usuários por guilda (ids ou nomes).
- `guilds.<id>.tools`: substituições opcionais de política de ferramentas por guilda (`allow`/`deny`/`alsoAllow`) usadas quando a substituição de canal está ausente.
- `guilds.<id>.toolsBySender`: substituições opcionais de política de ferramentas por remetente no nível da guilda (aplica-se quando a substituição de canal está ausente; curinga `"*"` suportado).
- `guilds.<id>.channels.<channel>.allow`: permitir/negar o canal quando `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: controle por menção para o canal.
- `guilds.<id>.channels.<channel>.tools`: substituições opcionais de política de ferramentas por canal (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: substituições opcionais de política de ferramentas por remetente dentro do canal (curinga `"*"` suportado).
- `guilds.<id>.channels.<channel>.users`: lista de permissões opcional de usuários por canal.
- `guilds.<id>.channels.<channel>.skills`: filtro de skills (omitir = todas as skills, vazio = nenhuma).
- `guilds.<id>.channels.<channel>.systemPrompt`: prompt de sistema extra para o canal. Tópicos de canais do Discord são injetados como contexto **não confiável** (não como prompt de sistema).
- `guilds.<id>.channels.<channel>.enabled`: defina `false` para desativar o canal.
- `guilds.<id>.channels`: regras de canal (chaves são slugs ou ids de canal).
- `guilds.<id>.requireMention`: requisito de menção por guilda (substituível por canal).
- `guilds.<id>.reactionNotifications`: modo de evento do sistema de reações (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: tamanho do bloco de texto de saída (chars). Padrão: 2000.
- `chunkMode`: `length` (padrão) divide apenas ao exceder `textChunkLimit`; `newline` divide em linhas em branco (limites de parágrafo) antes do fracionamento por tamanho.
- `maxLinesPerMessage`: contagem máxima suave de linhas por mensagem. Padrão: 17.
- `mediaMaxMb`: limitar mídia de entrada salva em disco.
- `historyLimit`: número de mensagens recentes da guilda a incluir como contexto ao responder a uma menção (padrão 20; fallback para `messages.groupChat.historyLimit`; `0` desativa).
- `dmHistoryLimit`: limite de histórico de DM em turnos do usuário. Substituições por usuário: `dms["<user_id>"].historyLimit`.
- `retry`: política de retry para chamadas de saída da API do Discord (tentativas, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: resolver mensagens proxied do PluralKit para que membros do sistema apareçam como remetentes distintos.
- `actions`: controles de ferramentas por ação; omita para permitir tudo (defina `false` para desativar).
  - `reactions` (cobre reagir + ler reações)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (criar/editar/excluir canais + categorias + permissões)
  - `roles` (adicionar/remover cargos, padrão `false`)
  - `moderation` (timeout/expulsar/banir, padrão `false`)
  - `presence` (status/atividade do bot, padrão `false`)
- `execApprovals`: DMs de aprovação de exec somente para Discord (UI de botões). Suporta `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Notificações de reação usam `guilds.<id>.reactionNotifications`:

- `off`: sem eventos de reação.
- `own`: reações nas próprias mensagens do bot (padrão).
- `all`: todas as reações em todas as mensagens.
- `allowlist`: reações de `guilds.<id>.users` em todas as mensagens (lista vazia desativa).

### Suporte ao PluralKit (PK)

Ative buscas do PK para que mensagens proxied sejam resolvidas para o sistema + membro subjacentes.
Quando ativado, o OpenClaw usa a identidade do membro para listas de permissões e rotula o
remetente como `Member (PK:System)` para evitar pings acidentais no Discord.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Notas de lista de permissões (com PK ativado):

- Use `pk:<memberId>` em `dm.allowFrom`, `guilds.<id>.users` ou por canal `users`.
- Nomes de exibição de membros também são correspondidos por nome/slug.
- As buscas usam o ID da mensagem **original** do Discord (a mensagem pré-proxy), então
  a API do PK só resolve dentro de sua janela de 30 minutos.
- Se as buscas do PK falharem (por exemplo, sistema privado sem token), mensagens proxied
  são tratadas como mensagens de bot e descartadas, a menos que `channels.discord.allowBots=true`.

### Padrões de ações de ferramentas

| Grupo de ações | Padrão   | Notas                                                    |
| -------------- | -------- | -------------------------------------------------------- |
| reactions      | enabled  | Reagir + listar reações + emojiList                      |
| stickers       | enabled  | Enviar stickers                                          |
| emojiUploads   | enabled  | Enviar emojis                                            |
| stickerUploads | enabled  | Enviar stickers                                          |
| polls          | enabled  | Criar enquetes                                           |
| permissions    | enabled  | Snapshot de permissões do canal                          |
| messages       | enabled  | Ler/enviar/editar/excluir                                |
| threads        | enabled  | Criar/listar/responder                                   |
| pins           | enabled  | Fixar/desafixar/listar                                   |
| search         | enabled  | Busca de mensagens (recurso prévia)   |
| memberInfo     | enabled  | Informações do membro                                    |
| roleInfo       | enabled  | Lista de cargos                                          |
| channelInfo    | enabled  | Info do canal + lista                                    |
| channels       | enabled  | Gerenciamento de canais/categorias                       |
| voiceStatus    | enabled  | Consulta de estado de voz                                |
| events         | enabled  | Listar/criar eventos agendados                           |
| roles          | disabled | Adicionar/remover cargos                                 |
| moderation     | disabled | Timeout/expulsar/banir                                   |
| presence       | disabled | Status/atividade do bot (setPresence) |

- `replyToMode`: `off` (padrão), `first` ou `all`. Aplica-se apenas quando o modelo inclui uma tag de resposta.

## Tags de resposta

Para solicitar uma resposta em thread, o modelo pode incluir uma tag em sua saída:

- `[[reply_to_current]]` — responder à mensagem do Discord que acionou.
- `[[reply_to:<id>]]` — responder a um id de mensagem específico do contexto/histórico.
  IDs de mensagens atuais são anexados aos prompts como `[message_id: …]`; entradas de histórico já incluem ids.

O comportamento é controlado por `channels.discord.replyToMode`:

- `off`: ignorar tags.
- `first`: apenas o primeiro bloco/anexo de saída é uma resposta.
- `all`: todo bloco/anexo de saída é uma resposta.

Notas sobre correspondência de listas de permissões:

- `allowFrom`/`users`/`groupChannels` aceitam ids, nomes, tags ou menções como `<@id>`.
- Prefixos como `discord:`/`user:` (usuários) e `channel:` (DMs em grupo) são suportados.
- Use `*` para permitir qualquer remetente/canal.
- Quando `guilds.<id>.channels` está presente, canais não listados são negados por padrão.
- Quando `guilds.<id>.channels` é omitido, todos os canais na guilda permitida são aceitos.
- Para permitir **nenhum canal**, defina `channels.discord.groupPolicy: "disabled"` (ou mantenha uma lista vazia).
- O assistente de configuração aceita nomes `Guild/Channel` (públicos + privados) e os resolve para IDs quando possível.
- Na inicialização, o OpenClaw resolve nomes de canais/usuários em listas de permissões para IDs (quando o bot pode pesquisar membros)
  e registra o mapeamento; entradas não resolvidas são mantidas como digitadas.

Notas sobre comandos nativos:

- Os comandos registrados espelham os comandos de chat do OpenClaw.
- Comandos nativos respeitam as mesmas listas de permissões que DMs/mensagens de guilda (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, regras por canal).
- Slash commands ainda podem ser visíveis na UI do Discord para usuários que não estão na lista de permissões; o OpenClaw aplica as listas na execução e responde “não autorizado”.

## Ações de ferramentas

O agente pode chamar `discord` com ações como:

- `react` / `reactions` (adicionar ou listar reações)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Cargas de ferramentas de leitura/busca/fixação incluem `timestampMs` normalizado (UTC epoch ms) e `timestampUtc` junto com `timestamp` bruto do Discord.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (atividade do bot e status online)

IDs de mensagens do Discord são expostos no contexto injetado (`[discord message id: …]` e linhas de histórico) para que o agente possa direcioná-los.
Emojis podem ser unicode (ex.: `✅`) ou sintaxe de emoji personalizada como `<:party_blob:1234567890>`.

## Segurança e operações

- Trate o token do bot como uma senha; prefira a variável de ambiente `DISCORD_BOT_TOKEN` em hosts supervisionados ou restrinja as permissões do arquivo de configuração.
- Conceda ao bot apenas as permissões necessárias (normalmente Ler/Enviar mensagens).
- Se o bot travar ou estiver limitado por taxa, reinicie o gateway (`openclaw gateway --force`) após confirmar que nenhum outro processo possui a sessão do Discord.
