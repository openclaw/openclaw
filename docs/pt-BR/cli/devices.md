---
summary: "Referência da CLI para `openclaw devices` (emparelhamento de dispositivos + rotação/revogação de tokens)"
read_when:
  - Você está aprovando solicitações de emparelhamento de dispositivos
  - Você precisa rotacionar ou revogar tokens de dispositivos
title: "dispositivos"
---

# `openclaw devices`

Gerencie solicitações de emparelhamento de dispositivos e tokens com escopo por dispositivo.

## Commands

### `openclaw devices list`

Liste solicitações de emparelhamento pendentes e dispositivos emparelhados.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Aprove uma solicitação de emparelhamento de dispositivo pendente.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Rejeite uma solicitação de emparelhamento de dispositivo pendente.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotacione um token de dispositivo para uma função específica (opcionalmente atualizando escopos).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Revogue um token de dispositivo para uma função específica.

```
openclaw devices revoke --device <deviceId> --role node
```

## Opções comuns

- `--url <url>`: URL do WebSocket do Gateway (o padrão é `gateway.remote.url` quando configurado).
- `--token <token>`: Token do Gateway (se necessário).
- `--password <password>`: Senha do Gateway (autenticação por senha).
- `--timeout <ms>`: Tempo limite de RPC.
- `--json`: Saída JSON (recomendado para scripts).

Nota: quando você define `--url`, a CLI não faz fallback para credenciais de configuração ou de ambiente.
Passe `--token` ou `--password` explicitamente. A ausência de credenciais explícitas é um erro.

## Notas

- A rotação de token retorna um novo token (sensível). Trate-o como um segredo.
- Esses comandos exigem o escopo `operator.pairing` (ou `operator.admin`).
