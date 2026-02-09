---
summary: "Reguły routingu per kanał (WhatsApp, Telegram, Discord, Slack) oraz współdzielony kontekst"
read_when:
  - Zmiana routingu kanałów lub zachowania skrzynki odbiorczej
title: "Routing kanałów"
---

# Kanały i routing

OpenClaw kieruje odpowiedzi **z powrotem do kanału, z którego pochodziła wiadomość**. Model nie wybiera kanału; routing jest deterministyczny i kontrolowany przez konfigurację hosta.

## Kluczowe pojęcia

- **Kanał**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: instancja konta per kanał (jeśli obsługiwane).
- **AgentId**: izolowany obszar roboczy + magazyn sesji („mózg”).
- **SessionKey**: klucz koszyka używany do przechowywania kontekstu i kontroli współbieżności.

## Kształty klucza sesji (przykłady)

Wiadomości bezpośrednie są łączone do **głównej** sesji agenta:

- `agent:<agentId>:<mainKey>` (domyślnie: `agent:main:main`)

Grupy i kanały pozostają izolowane per kanał:

- Grupy: `agent:<agentId>:<channel>:group:<id>`
- Kanały/pokoje: `agent:<agentId>:<channel>:channel:<id>`

Wątki:

- Wątki Slack/Discord dołączają `:thread:<threadId>` do klucza bazowego.
- Tematy forum Telegrama osadzają `:topic:<topicId>` w kluczu grupy.

Przykłady:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Reguły routingu (jak wybierany jest agent)

Routing wybiera **jednego agenta** dla każdej wiadomości przychodzącej:

1. **Dokładne dopasowanie rozmówcy** (`bindings` z `peer.kind` + `peer.id`).
2. **Dopasowanie gildii** (Discord) przez `guildId`.
3. **Dopasowanie zespołu** (Slack) przez `teamId`.
4. **Dopasowanie konta** (`accountId` na kanale).
5. **Dopasowanie kanału** (dowolne konto na tym kanale).
6. **Agent domyślny** (`agents.list[].default`, w przeciwnym razie pierwsza pozycja listy, awaryjnie `main`).

Dopasowany agent determinuje, który obszar roboczy i magazyn sesji są używane.

## Grupy rozgłoszeniowe (uruchamianie wielu agentów)

Grupy rozgłoszeniowe pozwalają uruchamiać **wielu agentów** dla tego samego rozmówcy **gdy OpenClaw normalnie by odpowiedział** (na przykład: w grupach WhatsApp, po bramkowaniu wzmianką/aktywacją).

Konfiguracja:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Zobacz: [Grupy rozgłoszeniowe](/channels/broadcast-groups).

## Przegląd konfiguracji

- `agents.list`: nazwane definicje agentów (obszar roboczy, model itp.).
- `bindings`: mapowanie kanałów/kont/rozmówców przychodzących na agentów.

Przykład:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## Przechowywanie sesji

Magazyny sesji znajdują się w katalogu stanu (domyślnie `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transkrypty JSONL znajdują się obok magazynu

Ścieżkę magazynu można nadpisać za pomocą `session.store` oraz szablonowania `{agentId}`.

## Zachowanie WebChat

WebChat dołącza do **wybranego agenta** i domyślnie używa głównej sesji agenta. Z tego powodu WebChat pozwala zobaczyć w jednym miejscu kontekst międzykanałowy dla tego agenta.

## Kontekst odpowiedzi

Odpowiedzi przychodzące zawierają:

- `ReplyToId`, `ReplyToBody` oraz `ReplyToSender`, gdy są dostępne.
- Cytowany kontekst jest dołączany do `Body` jako blok `[Replying to ...]`.

Jest to spójne we wszystkich kanałach.
