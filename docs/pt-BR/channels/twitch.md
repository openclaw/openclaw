---
summary: "Configuração e instalação do bot de chat do Twitch"
read_when:
  - Configurando a integração de chat do Twitch para o OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Suporte a chat do Twitch via conexão IRC. O OpenClaw se conecta como um usuário do Twitch (conta de bot) para receber e enviar mensagens em canais.

## Plugin necessário

O Twitch é distribuído como um plugin e não vem incluído na instalação principal.

Instale via CLI (registro npm):

```bash
openclaw plugins install @openclaw/twitch
```

Checkout local (ao executar a partir de um repositório git):

```bash
openclaw plugins install ./extensions/twitch
```

Detalhes: [Plugins](/tools/plugin)

## Configuração rápida (iniciante)

1. Crie uma conta dedicada no Twitch para o bot (ou use uma conta existente).
2. Gere as credenciais: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Selecione **Bot Token**
   - Verifique se os escopos `chat:read` e `chat:write` estão selecionados
   - Copie o **Client ID** e o **Access Token**
3. Encontre seu ID de usuário do Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Configure o token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (apenas conta padrão)
   - Ou config: `channels.twitch.accessToken`
   - Se ambos estiverem definidos, a configuração tem precedência (o env é fallback apenas para a conta padrão).
5. Inicie o gateway.

**⚠️ Importante:** Adicione controle de acesso (`allowFrom` ou `allowedRoles`) para evitar que usuários não autorizados acionem o bot. `requireMention` tem como padrão `true`.

Configuração mínima:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## O que é

- Um canal do Twitch pertencente ao Gateway.
- Roteamento determinístico: as respostas sempre retornam para o Twitch.
- Cada conta mapeia para uma chave de sessão isolada `agent:<agentId>:twitch:<accountName>`.
- `username` é a conta do bot (que autentica), `channel` é a sala de chat a ser acessada.

## Configuração (detalhada)

### Gerar credenciais

Use o [Twitch Token Generator](https://twitchtokengenerator.com/):

- Selecione **Bot Token**
- Verifique se os escopos `chat:read` e `chat:write` estão selecionados
- Copie o **Client ID** e o **Access Token**

Não é necessário registrar manualmente um app. Os tokens expiram após várias horas.

### Configurar o bot

**Variável de ambiente (apenas conta padrão):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Ou configuração:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Se tanto o env quanto a config estiverem definidos, a configuração tem precedência.

### Controle de acesso (recomendado)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefira `allowFrom` para uma lista de permissões rígida. Use `allowedRoles` se quiser acesso baseado em papéis.

**Papéis disponíveis:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Por que IDs de usuário?** Nomes de usuário podem mudar, permitindo falsificação. IDs de usuário são permanentes. IDs de usuário são permanentes.

Encontre seu ID de usuário do Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Converta seu nome de usuário do Twitch em ID)

## Renovação de token (opcional)

Tokens do [Twitch Token Generator](https://twitchtokengenerator.com/) não podem ser renovados automaticamente — gere novamente quando expirarem.

Para renovação automática de tokens, crie seu próprio aplicativo do Twitch no [Twitch Developer Console](https://dev.twitch.tv/console) e adicione à configuração:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

O bot renova automaticamente os tokens antes da expiração e registra eventos de renovação nos logs.

## Suporte a múltiplas contas

Use `channels.twitch.accounts` com tokens por conta. Veja [`gateway/configuration`](/gateway/configuration) para o padrão compartilhado.

Exemplo (uma conta de bot em dois canais):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Nota:** Cada conta precisa do seu próprio token (um token por canal).

## Controle de acesso

### Restrições baseadas em papéis

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Lista de permissões por ID de usuário (mais seguro)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Acesso baseado em papéis (alternativa)

`allowFrom` é uma lista de permissões rígida. Quando definida, apenas esses IDs de usuário são permitidos.
Se você quiser acesso baseado em papéis, deixe `allowFrom` indefinido e configure `allowedRoles` em vez disso:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Desativar exigência de @menção

Por padrão, `requireMention` é `true`. Para desativar e responder a todas as mensagens:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Solução de problemas

Primeiro, execute os comandos de diagnóstico:

```bash
openclaw doctor
openclaw channels status --probe
```

### O bot não responde às mensagens

**Verifique o controle de acesso:** Certifique-se de que seu ID de usuário está em `allowFrom`, ou remova temporariamente
`allowFrom` e defina `allowedRoles: ["all"]` para testar.

**Verifique se o bot está no canal:** O bot deve entrar no canal especificado em `channel`.

### Problemas com token

**"Failed to connect" ou erros de autenticação:**

- Verifique se `accessToken` é o valor do token de acesso OAuth (normalmente começa com o prefixo `oauth:`)
- Verifique se o token tem os escopos `chat:read` e `chat:write`
- Se estiver usando renovação de token, verifique se `clientSecret` e `refreshToken` estão definidos

### Renovação de token não funciona

**Verifique os logs para eventos de renovação:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Se você vir "token refresh disabled (no refresh token)":

- Certifique-se de que `clientSecret` foi fornecido
- Certifique-se de que `refreshToken` foi fornecido

## Configuração

**Configuração da conta:**

- `username` - Nome de usuário do bot
- `accessToken` - Token de acesso OAuth com `chat:read` e `chat:write`
- `clientId` - Client ID do Twitch (do Token Generator ou do seu app)
- `channel` - Canal a ser acessado (obrigatório)
- `enabled` - Ativar esta conta (padrão: `true`)
- `clientSecret` - Opcional: Para renovação automática de token
- `refreshToken` - Opcional: Para renovação automática de token
- `expiresIn` - Expiração do token em segundos
- `obtainmentTimestamp` - Timestamp de obtenção do token
- `allowFrom` - Lista de permissões por ID de usuário
- `allowedRoles` - Controle de acesso baseado em papéis (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Exigir @menção (padrão: `true`)

**Opções do provedor:**

- `channels.twitch.enabled` - Ativar/desativar inicialização do canal
- `channels.twitch.username` - Nome de usuário do bot (configuração simplificada de conta única)
- `channels.twitch.accessToken` - Token de acesso OAuth (configuração simplificada de conta única)
- `channels.twitch.clientId` - Client ID do Twitch (configuração simplificada de conta única)
- `channels.twitch.channel` - Canal a ser acessado (configuração simplificada de conta única)
- `channels.twitch.accounts.<accountName>` - Configuração multi-conta (todos os campos de conta acima)

Exemplo completo:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Ações da ferramenta

O agente pode chamar `twitch` com a ação:

- `send` - Enviar uma mensagem para um canal

Exemplo:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Segurança e operações

- **Trate tokens como senhas** — Nunca versionar tokens no git
- **Use renovação automática de tokens** para bots de longa duração
- **Use listas de permissões por ID de usuário** em vez de nomes de usuário para controle de acesso
- **Monitore os logs** para eventos de renovação de token e status de conexão
- **Limite os escopos dos tokens** — Solicite apenas `chat:read` e `chat:write`
- **Se travar**: Reinicie o gateway após confirmar que nenhum outro processo possui a sessão

## Limites

- **500 caracteres** por mensagem (divididos automaticamente em limites de palavras)
- Markdown é removido antes da divisão
- Sem limitação de taxa (usa os limites nativos do Twitch)
