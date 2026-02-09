---
summary: "Comportamento de chats em grupo entre superfícies (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Alterar o comportamento de chats em grupo ou o controle por menções
title: "Grupos"
---

# Grupos

O OpenClaw trata chats em grupo de forma consistente entre as superfícies: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Introdução para iniciantes (2 minutos)

O OpenClaw “vive” nas suas próprias contas de mensagens. Não existe um usuário de bot separado no WhatsApp.
Se **você** está em um grupo, o OpenClaw pode ver esse grupo e responder ali.

Comportamento padrão:

- Grupos são restritos (`groupPolicy: "allowlist"`).
- Respostas exigem uma menção, a menos que você desative explicitamente o controle por menções.

Tradução: remetentes na lista de permissões podem acionar o OpenClaw mencionando-o.

> TL;DR
>
> - **Acesso a DM** é controlado por `*.allowFrom`.
> - **Acesso a grupos** é controlado por `*.groupPolicy` + listas de permissões (`*.groups`, `*.groupAllowFrom`).
> - **Disparo de respostas** é controlado pelo controle por menções (`requireMention`, `/activation`).

Fluxo rápido (o que acontece com uma mensagem de grupo):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Fluxo de mensagem de grupo](/images/groups-flow.svg)

Se você quiser...

| Objetivo                                                            | O que configurar                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Permitir todos os grupos, mas responder só em @menções | `groups: { "*": { requireMention: true } }`                                |
| Desativar todas as respostas em grupos                              | `groupPolicy: "disabled"`                                                  |
| Apenas grupos específicos                                           | `groups: { "<group-id>": { ... } }` (sem a chave `"*"`) |
| Apenas você pode acionar em grupos                                  | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                 |

## Chaves de sessão

- Sessões de grupo usam chaves de sessão `agent:<agentId>:<channel>:group:<id>` (salas/canais usam `agent:<agentId>:<channel>:channel:<id>`).
- Tópicos de fórum do Telegram adicionam `:topic:<threadId>` ao id do grupo, para que cada tópico tenha sua própria sessão.
- Chats diretos usam a sessão principal (ou por remetente, se configurado).
- Heartbeats são ignorados para sessões de grupo.

## Padrão: DMs pessoais + grupos públicos (agente único)

Sim — isso funciona bem se seu tráfego “pessoal” for **DMs** e seu tráfego “público” for **grupos**.

Por quê: no modo de agente único, DMs normalmente caem na chave de sessão **principal** (`agent:main:main`), enquanto grupos sempre usam chaves de sessão **não principais** (`agent:main:<channel>:group:<id>`). Se você habilitar sandboxing com `mode: "non-main"`, essas sessões de grupo rodam no Docker enquanto sua sessão principal de DM permanece no host.

Isso lhe dá um único “cérebro” de agente (workspace + memória compartilhados), mas duas posturas de execução:

- **DMs**: ferramentas completas (host)
- **Grupos**: sandbox + ferramentas restritas (Docker)

> Se você precisa de workspaces/personas realmente separados (“pessoal” e “público” nunca podem se misturar), use um segundo agente + bindings. Veja [Roteamento Multi-Agente](/concepts/multi-agent).

Exemplo (DMs no host, grupos em sandbox + ferramentas apenas de mensagens):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Quer “grupos só podem ver a pasta X” em vez de “sem acesso ao host”? Mantenha `workspaceAccess: "none"` e monte apenas os caminhos na lista de permissões no sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Relacionado:

- Chaves de configuração e padrões: [Configuração do Gateway](/gateway/configuration#agentsdefaultssandbox)
- Depuração de por que uma ferramenta está bloqueada: [Sandbox vs Política de Ferramentas vs Elevado](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Detalhes de bind mounts: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Rótulos de exibição

- Rótulos da UI usam `displayName` quando disponível, formatado como `<channel>:<token>`.
- `#room` é reservado para salas/canais; chats em grupo usam `g-<slug>` (minúsculas, espaços -> `-`, manter `#@+._-`).

## Política de grupos

Controle como mensagens de grupo/sala são tratadas por canal:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Política      | Comportamento                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `"open"`      | Grupos ignoram listas de permissões; controle por menções ainda se aplica.       |
| `"disabled"`  | Bloquear todas as mensagens de grupo por completo.                               |
| `"allowlist"` | Permitir apenas grupos/salas que correspondam à lista de permissões configurada. |

Notas:

- `groupPolicy` é separado do controle por menções (que exige @menções).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: use `groupAllowFrom` (fallback: `allowFrom` explícito).
- Discord: a lista de permissões usa `channels.discord.guilds.<id>.channels`.
- Slack: a lista de permissões usa `channels.slack.channels`.
- Matrix: a lista de permissões usa `channels.matrix.groups` (IDs de sala, aliases ou nomes). Use `channels.matrix.groupAllowFrom` para restringir remetentes; listas de permissões por sala `users` também são suportadas.
- DMs em grupo são controladas separadamente (`channels.discord.dm.*`, `channels.slack.dm.*`).
- A lista de permissões do Telegram pode corresponder a IDs de usuário (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) ou nomes de usuário (`"@alice"` ou `"alice"`); prefixos não diferenciam maiúsculas/minúsculas.
- O padrão é `groupPolicy: "allowlist"`; se sua lista de permissões de grupos estiver vazia, mensagens de grupo são bloqueadas.

Modelo mental rápido (ordem de avaliação para mensagens de grupo):

1. `groupPolicy` (open/disabled/allowlist)
2. listas de permissões de grupo (`*.groups`, `*.groupAllowFrom`, lista específica do canal)
3. controle por menções (`requireMention`, `/activation`)

## Mencionar gating (padrão)

Mensagens de grupo exigem uma menção, a menos que sejam substituídas por grupo. Os padrões vivem por subsistema em `*.groups."*"`.

Responder a uma mensagem do bot conta como uma menção implícita (quando o canal suporta metadados de resposta). Isso se aplica a Telegram, WhatsApp, Slack, Discord e Microsoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Notas:

- `mentionPatterns` são regexes que não diferenciam maiúsculas/minúsculas.
- Superfícies que fornecem menções explícitas ainda passam; os padrões são um fallback.
- Substituição por agente: `agents.list[].groupChat.mentionPatterns` (útil quando vários agentes compartilham um grupo).
- O controle por menções só é aplicado quando a detecção de menções é possível (menções nativas ou `mentionPatterns` configurados).
- Os padrões do Discord vivem em `channels.discord.guilds."*"` (substituíveis por guild/canal).
- O contexto de histórico de grupo é encapsulado de forma uniforme entre canais e é **apenas pendente** (mensagens ignoradas por causa do controle por menções); use `messages.groupChat.historyLimit` para o padrão global e `channels.<channel>.historyLimit` (ou `channels.<channel>.accounts.*.historyLimit`) para substituições. Defina `0` para desativar.

## Restrições de ferramentas por grupo/canal (opcional)

Algumas configurações de canal suportam restringir quais ferramentas estão disponíveis **dentro de um grupo/sala/canal específico**.

- `tools`: permitir/negar ferramentas para o grupo inteiro.
- `toolsBySender`: substituições por remetente dentro do grupo (as chaves são IDs de remetente/nomes de usuário/emails/números de telefone, dependendo do canal). Use `"*"` como curinga.

Ordem de resolução (o mais específico vence):

1. correspondência de `toolsBySender` do grupo/canal
2. `tools` do grupo/canal
3. correspondência padrão (`"*"`) `toolsBySender`
4. padrão (`"*"`) `tools`

Exemplo (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Notas:

- Restrições de ferramentas por grupo/canal são aplicadas além da política global/do agente (negação ainda vence).
- Alguns canais usam aninhamento diferente para salas/canais (por exemplo, Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Listas de permissões de grupos

Quando `channels.whatsapp.groups`, `channels.telegram.groups` ou `channels.imessage.groups` é configurado, as chaves atuam como uma lista de permissões de grupos. Use `"*"` para permitir todos os grupos enquanto ainda define o comportamento padrão de menções.

Intenções comuns (copiar/colar):

1. Desativar todas as respostas em grupos

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Permitir apenas grupos específicos (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Permitir todos os grupos, mas exigir menção (explícito)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Apenas o proprietário pode acionar em grupos (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Ativação (apenas proprietário)

Proprietários de grupos podem alternar a ativação por grupo:

- `/activation mention`
- `/activation always`

O proprietário é determinado por `channels.whatsapp.allowFrom` (ou o E.164 próprio do bot quando não definido). Envie o comando como uma mensagem independente. Outras superfícies atualmente ignoram `/activation`.

## Campos de contexto

Payloads de entrada de grupo definem:

- `ChatType=group`
- `GroupSubject` (se conhecido)
- `GroupMembers` (se conhecido)
- `WasMentioned` (resultado do controle por menções)
- Tópicos de fórum do Telegram também incluem `MessageThreadId` e `IsForum`.

O prompt de sistema do agente inclui uma introdução de grupo no primeiro turno de uma nova sessão de grupo. Ele lembra o modelo de responder como um humano, evitar tabelas em Markdown e evitar digitar sequências literais `\n`.

## Especificidades do iMessage

- Prefira `chat_id:<id>` ao rotear ou criar listas de permissões.
- Listar chats: `imsg chats --limit 20`.
- Respostas em grupo sempre retornam ao mesmo `chat_id`.

## Especificidades do WhatsApp

Veja [Mensagens de grupo](/channels/group-messages) para comportamento exclusivo do WhatsApp (injeção de histórico, detalhes de tratamento de menções).
