---
summary: "Visão geral do bot Feishu, recursos e configuração"
read_when:
  - Você quer conectar um bot Feishu/Lark
  - Você está configurando o canal Feishu
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:13Z
---

# Bot Feishu

Feishu (Lark) é uma plataforma de chat corporativo usada por empresas para mensagens e colaboração. Este plugin conecta o OpenClaw a um bot Feishu/Lark usando a assinatura de eventos WebSocket da plataforma, para que as mensagens possam ser recebidas sem expor uma URL pública de webhook.

---

## Plugin necessário

Instale o plugin Feishu:

```bash
openclaw plugins install @openclaw/feishu
```

Checkout local (ao executar a partir de um repositório git):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Início rápido

Há duas maneiras de adicionar o canal Feishu:

### Método 1: assistente de onboarding (recomendado)

Se você acabou de instalar o OpenClaw, execute o assistente:

```bash
openclaw onboard
```

O assistente guia você por:

1. Criar um app Feishu e coletar credenciais
2. Configurar as credenciais do app no OpenClaw
3. Iniciar o gateway

✅ **Após a configuração**, verifique o status do gateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### Método 2: configuração da CLI

Se você já concluiu a instalação inicial, adicione o canal via CLI:

```bash
openclaw channels add
```

Escolha **Feishu** e, em seguida, informe o App ID e o App Secret.

✅ **Após a configuração**, gerencie o gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Etapa 1: Criar um app Feishu

### 1. Abrir o Feishu Open Platform

Acesse o [Feishu Open Platform](https://open.feishu.cn/app) e faça login.

Tenants Lark (global) devem usar [https://open.larksuite.com/app](https://open.larksuite.com/app) e definir `domain: "lark"` na configuração do Feishu.

### 2. Criar um app

1. Clique em **Create enterprise app**
2. Preencha o nome e a descrição do app
3. Escolha um ícone para o app

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Copiar credenciais

Em **Credentials & Basic Info**, copie:

- **App ID** (formato: `cli_xxx`)
- **App Secret**

❗ **Importante:** mantenha o App Secret em sigilo.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Configurar permissões

Em **Permissions**, clique em **Batch import** e cole:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Ativar a capacidade de bot

Em **App Capability** > **Bot**:

1. Ative a capacidade de bot
2. Defina o nome do bot

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Configurar assinatura de eventos

⚠️ **Importante:** antes de configurar a assinatura de eventos, certifique-se de que:

1. Você já executou `openclaw channels add` para o Feishu
2. O gateway está em execução (`openclaw gateway status`)

Em **Event Subscription**:

1. Escolha **Use long connection to receive events** (WebSocket)
2. Adicione o evento: `im.message.receive_v1`

⚠️ Se o gateway não estiver em execução, a configuração de conexão longa pode falhar ao salvar.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Publicar o app

1. Crie uma versão em **Version Management & Release**
2. Envie para revisão e publique
3. Aguarde a aprovação do administrador (apps corporativos geralmente são aprovados automaticamente)

---

## Etapa 2: Configurar o OpenClaw

### Configurar com o assistente (recomendado)

```bash
openclaw channels add
```

Escolha **Feishu** e cole seu App ID e App Secret.

### Configurar via arquivo de configuração

Edite `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Configurar via variáveis de ambiente

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Domínio Lark (global)

Se o seu tenant estiver no Lark (internacional), defina o domínio como `lark` (ou uma string de domínio completa). Você pode definir isso em `channels.feishu.domain` ou por conta (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Etapa 3: Iniciar + testar

### 1. Iniciar o gateway

```bash
openclaw gateway
```

### 2. Enviar uma mensagem de teste

No Feishu, encontre seu bot e envie uma mensagem.

### 3. Aprovar pareamento

Por padrão, o bot responde com um código de pareamento. Aprove-o:

```bash
openclaw pairing approve feishu <CODE>
```

Após a aprovação, você pode conversar normalmente.

---

## Visão geral

- **Canal de bot Feishu**: bot Feishu gerenciado pelo gateway
- **Roteamento determinístico**: as respostas sempre retornam ao Feishu
- **Isolamento de sessão**: DMs compartilham uma sessão principal; grupos são isolados
- **Conexão WebSocket**: conexão longa via SDK do Feishu, sem necessidade de URL pública

---

## Controle de acesso

### Mensagens diretas

- **Padrão**: `dmPolicy: "pairing"` (usuários desconhecidos recebem um código de pareamento)
- **Aprovar pareamento**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Modo de lista de permissões**: defina `channels.feishu.allowFrom` com Open IDs permitidos

### Chats em grupo

**1. Política de grupo** (`channels.feishu.groupPolicy`):

- `"open"` = permitir todos nos grupos (padrão)
- `"allowlist"` = permitir apenas `groupAllowFrom`
- `"disabled"` = desativar mensagens em grupo

**2. Requisito de menção** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = exigir @menção (padrão)
- `false` = responder sem menções

---

## Exemplos de configuração de grupos

### Permitir todos os grupos, exigir @menção (padrão)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Permitir todos os grupos, sem exigir @menção

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Permitir apenas usuários específicos em grupos

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Obter IDs de grupo/usuário

### IDs de grupo (chat_id)

Os IDs de grupo têm o formato `oc_xxx`.

**Método 1 (recomendado)**

1. Inicie o gateway e @mencione o bot no grupo
2. Execute `openclaw logs --follow` e procure por `chat_id`

**Método 2**

Use o depurador da API do Feishu para listar chats em grupo.

### IDs de usuário (open_id)

Os IDs de usuário têm o formato `ou_xxx`.

**Método 1 (recomendado)**

1. Inicie o gateway e envie uma DM ao bot
2. Execute `openclaw logs --follow` e procure por `open_id`

**Método 2**

Verifique solicitações de pareamento para Open IDs de usuários:

```bash
openclaw pairing list feishu
```

---

## Comandos comuns

| Comando   | Descrição             |
| --------- | --------------------- |
| `/status` | Mostrar status do bot |
| `/reset`  | Redefinir a sessão    |
| `/model`  | Mostrar/trocar modelo |

> Nota: o Feishu ainda não oferece suporte a menus de comandos nativos, portanto os comandos devem ser enviados como texto.

## Comandos de gerenciamento do gateway

| Comando                    | Descrição                             |
| -------------------------- | ------------------------------------- |
| `openclaw gateway status`  | Mostrar status do gateway             |
| `openclaw gateway install` | Instalar/iniciar o serviço do gateway |
| `openclaw gateway stop`    | Parar o serviço do gateway            |
| `openclaw gateway restart` | Reiniciar o serviço do gateway        |
| `openclaw logs --follow`   | Acompanhar logs do gateway            |

---

## Solução de problemas

### O bot não responde em chats de grupo

1. Certifique-se de que o bot foi adicionado ao grupo
2. Certifique-se de @mencionar o bot (comportamento padrão)
3. Verifique se `groupPolicy` não está definido como `"disabled"`
4. Verifique os logs: `openclaw logs --follow`

### O bot não recebe mensagens

1. Certifique-se de que o app está publicado e aprovado
2. Certifique-se de que a assinatura de eventos inclui `im.message.receive_v1`
3. Certifique-se de que a **conexão longa** está habilitada
4. Certifique-se de que as permissões do app estão completas
5. Certifique-se de que o gateway está em execução: `openclaw gateway status`
6. Verifique os logs: `openclaw logs --follow`

### Vazamento do App Secret

1. Redefina o App Secret no Feishu Open Platform
2. Atualize o App Secret na sua configuração
3. Reinicie o gateway

### Falhas no envio de mensagens

1. Certifique-se de que o app possui a permissão `im:message:send_as_bot`
2. Certifique-se de que o app está publicado
3. Verifique os logs para erros detalhados

---

## Configuração avançada

### Múltiplas contas

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Limites de mensagem

- `textChunkLimit`: tamanho do bloco de texto de saída (padrão: 2000 caracteres)
- `mediaMaxMb`: limite de upload/download de mídia (padrão: 30MB)

### Streaming

O Feishu oferece suporte a respostas em streaming via cartões interativos. Quando habilitado, o bot atualiza um cartão conforme gera o texto.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Defina `streaming: false` para aguardar a resposta completa antes de enviar.

### Roteamento multiagente

Use `bindings` para rotear DMs ou grupos do Feishu para diferentes agentes.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Campos de roteamento:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` ou `"group"`
- `match.peer.id`: Open ID do usuário (`ou_xxx`) ou ID do grupo (`oc_xxx`)

Consulte [Obter IDs de grupo/usuário](#get-groupuser-ids) para dicas de consulta.

---

## Referência de configuração

Configuração completa: [Configuração do Gateway](/gateway/configuration)

Opções principais:

| Configuração                                      | Descrição                                    | Padrão    |
| ------------------------------------------------- | -------------------------------------------- | --------- |
| `channels.feishu.enabled`                         | Ativar/desativar canal                       | `true`    |
| `channels.feishu.domain`                          | Domínio da API (`feishu` ou `lark`)          | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                       | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                   | -         |
| `channels.feishu.accounts.<id>.domain`            | Substituição de domínio da API por conta     | `feishu`  |
| `channels.feishu.dmPolicy`                        | Política de DM                               | `pairing` |
| `channels.feishu.allowFrom`                       | Lista de permissões de DM (lista de open_id) | -         |
| `channels.feishu.groupPolicy`                     | Política de grupo                            | `open`    |
| `channels.feishu.groupAllowFrom`                  | Lista de permissões de grupo                 | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | Exigir @menção                               | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Ativar grupo                                 | `true`    |
| `channels.feishu.textChunkLimit`                  | Tamanho do bloco de mensagem                 | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Limite de tamanho de mídia                   | `30`      |
| `channels.feishu.streaming`                       | Ativar saída de cartão em streaming          | `true`    |
| `channels.feishu.blockStreaming`                  | Ativar streaming em blocos                   | `true`    |

---

## Referência dmPolicy

| Valor         | Comportamento                                                                           |
| ------------- | --------------------------------------------------------------------------------------- |
| `"pairing"`   | **Padrão.** Usuários desconhecidos recebem um código de pareamento; devem ser aprovados |
| `"allowlist"` | Apenas usuários em `allowFrom` podem conversar                                          |
| `"open"`      | Permitir todos os usuários (requer `"*"` em allowFrom)                                  |
| `"disabled"`  | Desativar DMs                                                                           |

---

## Tipos de mensagem suportados

### Receber

- ✅ Texto
- ✅ Texto rico (post)
- ✅ Imagens
- ✅ Arquivos
- ✅ Áudio
- ✅ Vídeo
- ✅ Stickers

### Enviar

- ✅ Texto
- ✅ Imagens
- ✅ Arquivos
- ✅ Áudio
- ⚠️ Texto rico (suporte parcial)
