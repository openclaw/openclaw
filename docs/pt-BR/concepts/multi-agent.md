---
summary: "Roteamento multiagente: agentes isolados, contas de canal e vínculos"
title: Roteamento Multiagente
read_when: "Voce quer varios agentes isolados (workspaces + autenticação) em um unico processo do gateway."
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:47Z
---

# Roteamento Multiagente

Objetivo: varios agentes _isolados_ (workspace separado + `agentDir` + sessões), além de varias contas de canal (por exemplo, dois WhatsApps) em um Gateway em execução. As mensagens de entrada são roteadas para um agente por meio de vínculos.

## O que é “um agente”?

Um **agente** é um cérebro totalmente delimitado, com seu próprio:

- **Workspace** (arquivos, AGENTS.md/SOUL.md/USER.md, notas locais, regras de persona).
- **Diretório de estado** (`agentDir`) para perfis de autenticação, registro de modelos e configuração por agente.
- **Armazenamento de sessões** (histórico de chat + estado de roteamento) em `~/.openclaw/agents/<agentId>/sessions`.

Os perfis de autenticação são **por agente**. Cada agente lê do seu próprio:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

As credenciais do agente principal **não** são compartilhadas automaticamente. Nunca reutilize `agentDir`
entre agentes (isso causa colisões de autenticação/sessão). Se voce quiser compartilhar credenciais,
copie `auth-profiles.json` para o `agentDir` do outro agente.

As Skills são por agente via a pasta `skills/` de cada workspace, com skills compartilhadas
disponiveis em `~/.openclaw/skills`. Veja [Skills: por agente vs compartilhadas](/tools/skills#per-agent-vs-shared-skills).

O Gateway pode hospedar **um agente** (padrão) ou **muitos agentes** lado a lado.

**Nota sobre workspace:** o workspace de cada agente é o **cwd padrão**, não um sandbox rígido.
Caminhos relativos são resolvidos dentro do workspace, mas caminhos absolutos podem
alcançar outras localizações do host, a menos que o sandboxing esteja habilitado. Veja
[Sandboxing](/gateway/sandboxing).

## Caminhos (mapa rapido)

- Configuração: `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)
- Diretório de estado: `~/.openclaw` (ou `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<agentId>`)
- Diretório do agente: `~/.openclaw/agents/<agentId>/agent` (ou `agents.list[].agentDir`)
- Sessões: `~/.openclaw/agents/<agentId>/sessions`

### Modo de agente unico (padrão)

Se voce nao fizer nada, o OpenClaw executa um unico agente:

- `agentId` tem como padrão **`main`**.
- As sessões são indexadas como `agent:main:<mainKey>`.
- O workspace tem como padrão `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<profile>` quando `OPENCLAW_PROFILE` está definido).
- O estado tem como padrão `~/.openclaw/agents/main/agent`.

## Assistente de agente

Use o assistente de agente para adicionar um novo agente isolado:

```bash
openclaw agents add work
```

Em seguida, adicione `bindings` (ou deixe o assistente fazer isso) para rotear mensagens de entrada.

Verifique com:

```bash
openclaw agents list --bindings
```

## Multiplos agentes = multiplas pessoas, multiplas personalidades

Com **multiplos agentes**, cada `agentId` se torna uma **persona totalmente isolada**:

- **Numeros de telefone/contas diferentes** (por canal `accountId`).
- **Personalidades diferentes** (arquivos do workspace por agente, como `AGENTS.md` e `SOUL.md`).
- **Autenticação + sessões separadas** (sem interferencia cruzada, a menos que explicitamente habilitado).

Isso permite que **multiplas pessoas** compartilhem um servidor do Gateway mantendo seus “cérebros” de IA e dados isolados.

## Um numero do WhatsApp, multiplas pessoas (divisão de DM)

Voce pode rotear **DMs diferentes do WhatsApp** para agentes diferentes permanecendo em **uma unica conta do WhatsApp**. Faça a correspondencia pelo E.164 do remetente (como `+15551234567`) com `peer.kind: "dm"`. As respostas ainda saem do mesmo numero do WhatsApp (sem identidade de remetente por agente).

Detalhe importante: chats diretos colapsam para a **chave de sessão principal** do agente, portanto o isolamento verdadeiro exige **um agente por pessoa**.

Exemplo:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Notas:

- O controle de acesso de DM é **global por conta do WhatsApp** (pareamento/lista de permissões), nao por agente.
- Para grupos compartilhados, vincule o grupo a um agente ou use [Grupos de broadcast](/channels/broadcast-groups).

## Regras de roteamento (como as mensagens escolhem um agente)

Os vínculos sao **deterministicos** e **o mais especifico vence**:

1. Correspondencia de `peer` (DM/grupo/id de canal exato)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. Correspondencia de `accountId` para um canal
5. Correspondencia em nivel de canal (`accountId: "*"`)
6. Retorno ao agente padrão (`agents.list[].default`, caso contrario a primeira entrada da lista, padrão: `main`)

## Multiplas contas / numeros de telefone

Canais que suportam **multiplas contas** (por exemplo, WhatsApp) usam `accountId` para identificar
cada login. Cada `accountId` pode ser roteado para um agente diferente, assim um servidor pode hospedar
multiplos numeros de telefone sem misturar sessões.

## Conceitos

- `agentId`: um “cérebro” (workspace, autenticação por agente, armazenamento de sessões por agente).
- `accountId`: uma instancia de conta de canal (por exemplo, conta do WhatsApp `"personal"` vs `"biz"`).
- `binding`: roteia mensagens de entrada para um `agentId` por `(channel, accountId, peer)` e, opcionalmente, ids de guilda/equipe.
- Chats diretos colapsam para `agent:<agentId>:<mainKey>` (principal por agente; `session.mainKey`).

## Exemplo: dois WhatsApps → dois agentes

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Exemplo: chat diario no WhatsApp + trabalho profundo no Telegram

Divida por canal: roteie o WhatsApp para um agente rapido do dia a dia e o Telegram para um agente Opus.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Notas:

- Se voce tiver multiplas contas para um canal, adicione `accountId` ao vínculo (por exemplo, `{ channel: "whatsapp", accountId: "personal" }`).
- Para rotear um unico DM/grupo para o Opus mantendo o restante no chat, adicione um vínculo `match.peer` para esse par; correspondencias de par sempre vencem as regras em nivel de canal.

## Exemplo: mesmo canal, um par para o Opus

Mantenha o WhatsApp no agente rapido, mas roteie um DM para o Opus:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Vínculos de par sempre vencem, portanto mantenha-os acima da regra em nivel de canal.

## Agente de familia vinculado a um grupo do WhatsApp

Vincule um agente dedicado de familia a um unico grupo do WhatsApp, com controle por menções
e uma politica de ferramentas mais restrita:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Notas:

- Listas de permitir/negar ferramentas sao **ferramentas**, nao skills. Se uma skill precisar executar um
  binario, garanta que `exec` esteja permitido e que o binario exista no sandbox.
- Para um controle mais rigoroso, defina `agents.list[].groupChat.mentionPatterns` e mantenha
  listas de permissões de grupo habilitadas para o canal.

## Sandbox por agente e configuracao de ferramentas

A partir da v2026.1.6, cada agente pode ter seu proprio sandbox e restrições de ferramentas:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

Nota: `setupCommand` fica em `sandbox.docker` e é executado uma vez na criação do container.
Substituições `sandbox.docker.*` por agente sao ignoradas quando o escopo resolvido é `"shared"`.

**Beneficios:**

- **Isolamento de segurança**: restrinja ferramentas para agentes nao confiaveis
- **Controle de recursos**: coloque agentes especificos em sandbox mantendo outros no host
- **Politicas flexiveis**: permissoes diferentes por agente

Nota: `tools.elevated` é **global** e baseado no remetente; nao é configuravel por agente.
Se voce precisar de limites por agente, use `agents.list[].tools` para negar `exec`.
Para direcionamento de grupos, use `agents.list[].groupChat.mentionPatterns` para que @menções mapeiem corretamente para o agente pretendido.

Veja [Sandbox & Ferramentas Multiagente](/tools/multi-agent-sandbox-tools) para exemplos detalhados.
