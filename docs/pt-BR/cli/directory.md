---
summary: "Referência da CLI para `openclaw directory` (self, peers, groups)"
read_when:
  - Você quer procurar ids de contatos/grupos/self para um canal
  - Você está desenvolvendo um adaptador de diretório de canais
title: "diretório"
---

# `openclaw directory`

Consultas de diretório para canais que oferecem suporte (contatos/peers, grupos e “eu”).

## Flags comuns

- `--channel <name>`: id/alias do canal (obrigatório quando vários canais estão configurados; automático quando apenas um está configurado)
- `--account <id>`: id da conta (padrão: padrão do canal)
- `--json`: saída em JSON

## Notas

- `directory` foi pensado para ajudar você a encontrar IDs que podem ser colados em outros comandos (especialmente `openclaw message send --target ...`).
- Para muitos canais, os resultados são baseados em configuração (allowlists / grupos configurados) em vez de um diretório do provedor em tempo real.
- A saída padrão é `id` (e às vezes `name`) separados por uma tabulação; use `--json` para scripts.

## Usando resultados com `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## Formatos de ID (por canal)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (grupo)
- Telegram: `@username` ou id de chat numérico; grupos usam ids numéricos
- Slack: `user:U…` e `channel:C…`
- Discord: `user:<id>` e `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server` ou `#alias:server`
- Microsoft Teams (plugin): `user:<id>` e `conversation:<id>`
- Zalo (plugin): id do usuário (Bot API)
- Zalo Personal / `zalouser` (plugin): id do thread (DM/grupo) de `zca` (`me`, `friend list`, `group list`)

## Self (“eu”)

```bash
openclaw directory self --channel zalouser
```

## Peers (contatos/usuários)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Grupos

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
