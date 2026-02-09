---
summary: "Status de suporte do Tlon/Urbit, capacidades e configuração"
read_when:
  - Trabalhando em recursos do canal Tlon/Urbit
title: "Tlon"
---

# Tlon (plugin)

Tlon é um mensageiro descentralizado construído sobre o Urbit. O OpenClaw se conecta à sua nave Urbit e pode
responder a DMs e mensagens de chat em grupo. As respostas em grupo exigem uma menção com @ por padrão e podem
ser ainda mais restritas por meio de listas de permissões.

Status: suportado via plugin. DMs, menções em grupo, respostas em threads e fallback de mídia apenas em texto
(URL anexada à legenda). Reações, enquetes e uploads nativos de mídia não são suportados.

## Plugin obrigatório

O Tlon é distribuído como um plugin e não vem incluído na instalação principal.

Instale via CLI (registro npm):

```bash
openclaw plugins install @openclaw/tlon
```

Checkout local (ao executar a partir de um repositório git):

```bash
openclaw plugins install ./extensions/tlon
```

Detalhes: [Plugins](/tools/plugin)

## Configuração

1. Instale o plugin Tlon.
2. Reúna a URL da sua nave e o código de login.
3. Configure `channels.tlon`.
4. Reinicie o gateway.
5. Envie uma DM para o bot ou mencione-o em um canal de grupo.

Configuração mínima (conta única):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Canais de grupo

A descoberta automática é ativada por padrão. Você também pode fixar canais manualmente:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Desativar a descoberta automática:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Controle de acesso

Lista de permissões para DMs (vazia = permitir todos):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Autorização de grupos (restrita por padrão):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Destinos de entrega (CLI/cron)

Use estes com `openclaw message send` ou entrega via cron:

- DM: `~sampel-palnet` ou `dm/~sampel-palnet`
- Grupo: `chat/~host-ship/channel` ou `group:~host-ship/channel`

## Notas

- Respostas em grupo exigem uma menção (por exemplo, `~your-bot-ship`) para responder.
- Respostas em threads: se a mensagem de entrada estiver em uma thread, o OpenClaw responde na própria thread.
- Mídia: `sendMedia` faz fallback para texto + URL (sem upload nativo).
