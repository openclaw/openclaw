---
summary: "Wywołaj pojedyncze narzędzie bezpośrednio przez punkt końcowy HTTP Gateway"
read_when:
  - Wywoływanie narzędzi bez uruchamiania pełnego przebiegu agenta
  - Budowanie automatyzacji wymagających egzekwowania polityk narzędzi
title: "API wywoływania narzędzi"
---

# Wywoływanie narzędzi (HTTP)

Gateway OpenClaw udostępnia prosty punkt końcowy HTTP do bezpośredniego wywołania pojedynczego narzędzia. Jest on zawsze włączony, lecz chroniony uwierzytelnianiem Gateway i politykami narzędzi.

- `POST /tools/invoke`
- Ten sam port co Gateway (multipleksowanie WS + HTTP): `http://<gateway-host>:<port>/tools/invoke`

Domyślny maksymalny rozmiar ładunku wynosi 2 MB.

## Uwierzytelnianie

Wykorzystuje konfigurację uwierzytelniania Gateway. Wyślij token typu bearer:

- `Authorization: Bearer <token>`

Uwagi:

- Gdy `gateway.auth.mode="token"`, użyj `gateway.auth.token` (lub `OPENCLAW_GATEWAY_TOKEN`).
- Gdy `gateway.auth.mode="password"`, użyj `gateway.auth.password` (lub `OPENCLAW_GATEWAY_PASSWORD`).

## Treść żądania

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Pola:

- `tool` (string, wymagane): nazwa narzędzia do wywołania.
- `action` (string, opcjonalne): mapowane do args, jeśli schemat narzędzia obsługuje `action` i ładunek args go pomija.
- `args` (object, opcjonalne): argumenty specyficzne dla narzędzia.
- `sessionKey` (string, opcjonalne): docelowy klucz sesji. Jeśli pominięty lub `"main"`, Gateway używa skonfigurowanego głównego klucza sesji (respektuje `session.mainKey` i domyślnego agenta lub `global` w zakresie globalnym).
- `dryRun` (boolean, opcjonalne): zarezerwowane do przyszłego użytku; obecnie ignorowane.

## Zachowanie polityk i routingu

Dostępność narzędzi jest filtrowana przez ten sam łańcuch polityk, którego używają agenci Gateway:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- polityki grup (jeśli klucz sesji mapuje się na grupę lub kanał)
- polityka subagenta (przy wywołaniu z kluczem sesji subagenta)

Jeśli narzędzie nie jest dozwolone przez politykę, punkt końcowy zwraca **404**.

Aby pomóc politykom grup w rozwiązywaniu kontekstu, możesz opcjonalnie ustawić:

- `x-openclaw-message-channel: <channel>` (przykład: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (gdy istnieje wiele kont)

## Odpowiedzi

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (nieprawidłowe żądanie lub błąd narzędzia)
- `401` → nieautoryzowane
- `404` → narzędzie niedostępne (nie znaleziono lub nie znajduje się na liście dozwolonych)
- `405` → metoda niedozwolona

## Przykład

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
