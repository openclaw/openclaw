---
summary: "Configuração, ajuste e uso do plugin da API de Mensagens do LINE"
read_when:
  - Você quer conectar o OpenClaw ao LINE
  - Você precisa configurar webhook e credenciais do LINE
  - Você quer opções de mensagens específicas do LINE
title: LINE
---

# LINE (plugin)

O LINE se conecta ao OpenClaw por meio da API de Mensagens do LINE. O plugin é executado como um receptor de webhook no gateway e usa seu token de acesso do canal + segredo do canal para autenticação.

Status: suportado via plugin. Mensagens diretas, chats em grupo, mídia, localizações, mensagens Flex, mensagens de modelo e respostas rápidas são suportadas. Reações e threads não são suportadas.

## Plugin necessário

Instale o plugin do LINE:

```bash
openclaw plugins install @openclaw/line
```

Checkout local (ao executar a partir de um repositório git):

```bash
openclaw plugins install ./extensions/line
```

## Configuração

1. Crie uma conta LINE Developers e abra o Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Crie (ou selecione) um Provedor e adicione um canal de **Messaging API**.
3. Copie o **Channel access token** e o **Channel secret** das configurações do canal.
4. Ative **Use webhook** nas configurações da Messaging API.
5. Defina a URL do webhook para o endpoint do seu gateway (HTTPS obrigatório):

```
https://gateway-host/line/webhook
```

O gateway responde à verificação de webhook do LINE (GET) e a eventos de entrada (POST).
Se você precisar de um caminho personalizado, defina `channels.line.webhookPath` ou
`channels.line.accounts.<id>.webhookPath` e atualize a URL adequadamente.

## Configurar

Configuração mínima:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Variáveis de ambiente (apenas conta padrão):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Arquivos de token/segredo:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Múltiplas contas:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Controle de acesso

Mensagens diretas usam pareamento por padrão. Remetentes desconhecidos recebem um código de pareamento e suas mensagens são ignoradas até serem aprovadas.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Listas de permissões e políticas:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: IDs de usuário do LINE na lista de permissões para DMs
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: IDs de usuário do LINE na lista de permissões para grupos
- Substituições por grupo: `channels.line.groups.<groupId>.allowFrom`

IDs do LINE diferenciam maiúsculas de minúsculas. IDs válidos se parecem com:

- Usuário: `U` + 32 caracteres hexadecimais
- Grupo: `C` + 32 caracteres hexadecimais
- Sala: `R` + 32 caracteres hexadecimais

## Comportamento das mensagens

- O texto é dividido em blocos de 5000 caracteres.
- A formatação Markdown é removida; blocos de código e tabelas são convertidos em cartões Flex quando possível.
- Respostas em streaming são armazenadas em buffer; o LINE recebe blocos completos com uma animação de carregamento enquanto o agente trabalha.
- Downloads de mídia são limitados por `channels.line.mediaMaxMb` (padrão 10).

## Dados do canal (mensagens ricas)

Use `channelData.line` para enviar respostas rápidas, localizações, cartões Flex ou mensagens de modelo.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

O plugin do LINE também inclui um comando `/card` para predefinições de mensagens Flex:

```
/card info "Welcome" "Thanks for joining!"
```

## Solução de problemas

- **Falha na verificação do webhook:** garanta que a URL do webhook seja HTTPS e que `channelSecret` corresponda ao console do LINE.
- **Nenhum evento de entrada:** confirme que o caminho do webhook corresponde a `channels.line.webhookPath` e que o gateway esteja acessível a partir do LINE.
- **Erros no download de mídia:** aumente `channels.line.mediaMaxMb` se a mídia exceder o limite padrão.
