---
summary: "Architektura bramy WebSocket, komponenty i przepływy klientów"
read_when:
  - Praca nad protokołem Gateway, klientami lub transportami
title: "Architektura Gateway"
---

# Architektura Gateway

Ostatnia aktualizacja: 2026-01-22

## Przegląd

- Jeden długotrwały **Gateway** posiada wszystkie powierzchnie komunikacyjne (WhatsApp przez
  Baileys, Telegram przez grammY, Slack, Discord, Signal, iMessage, WebChat).
- Klienci płaszczyzny sterowania (aplikacja na macOS, CLI, interfejs webowy, automatyzacje) łączą się z
  Gateway przez **WebSocket** na skonfigurowanym hoście bindowania (domyślnie
  `127.0.0.1:18789`).
- **Węzły** (macOS/iOS/Android/headless) również łączą się przez **WebSocket**, ale
  deklarują `role: node` z jawnymi uprawnieniami/komendami.
- Jeden Gateway na host; jest to jedyne miejsce, które otwiera sesję WhatsApp.
- **Host canvas** (domyślnie `18793`) serwuje edytowalny przez agenta HTML oraz A2UI.

## Komponenty i przepływy

### Gateway (demon)

- Utrzymuje połączenia z dostawcami.
- Udostępnia typowany interfejs API WS (żądania, odpowiedzi, zdarzenia push z serwera).
- Waliduje przychodzące ramki względem JSON Schema.
- Emituje zdarzenia takie jak `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Klienci (aplikacja na macOS / CLI / panel webowy)

- Jedno połączenie WS na klienta.
- Wysyłają żądania (`health`, `status`, `send`, `agent`, `system-presence`).
- Subskrybują zdarzenia (`tick`, `agent`, `presence`, `shutdown`).

### Węzły (macOS / iOS / Android / headless)

- Łączą się z **tym samym serwerem WS** z `role: node`.
- Dostarczają tożsamość urządzenia w `connect`; parowanie jest **oparte na urządzeniu** (rola `node`), a
  zatwierdzenie jest przechowywane w magazynie parowania urządzeń.
- Udostępniają komendy takie jak `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Szczegóły protokołu:

- [Gateway protocol](/gateway/protocol)

### WebChat

- Statyczny interfejs, który używa API WS Gateway do historii czatu i wysyłania wiadomości.
- W konfiguracjach zdalnych łączy się przez ten sam tunel SSH/Tailscale co inne
  klienty.

## Cykl życia połączenia (pojedynczy klient)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## Protokół „na drucie” (podsumowanie)

- Transport: WebSocket, ramki tekstowe z ładunkami JSON.
- Pierwsza ramka **musi** być `connect`.
- Po uzgodnieniu:
  - Żądania: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Zdarzenia: `{type:"event", event, payload, seq?, stateVersion?}`
- Jeśli ustawiono `OPENCLAW_GATEWAY_TOKEN` (lub `--token`), `connect.params.auth.token`
  musi się zgadzać, w przeciwnym razie gniazdo jest zamykane.
- Klucze idempotencji są wymagane dla metod wywołujących skutki uboczne (`send`, `agent`), aby
  umożliwić bezpieczne ponawianie; serwer utrzymuje krótkotrwałą pamięć podręczną deduplikacji.
- Węzły muszą dołączyć `role: "node"` oraz uprawnienia/komendy/pozwolenia w `connect`.

## Parowanie + lokalne zaufanie

- Wszyscy klienci WS (operatorzy + węzły) dołączają **tożsamość urządzenia** w `connect`.
- Nowe identyfikatory urządzeń wymagają zatwierdzenia parowania; Gateway wydaje **token urządzenia**
  do kolejnych połączeń.
- Połączenia **lokalne** (local loopback lub własny adres tailnet hosta gateway) mogą być
  automatycznie zatwierdzane, aby zachować płynne UX na tym samym hoście.
- Połączenia **nielokalne** muszą podpisać nonce `connect.challenge` i wymagają
  jawnego zatwierdzenia.
- Uwierzytelnianie Gateway (`gateway.auth.*`) nadal obowiązuje dla **wszystkich** połączeń, lokalnych i
  zdalnych.

Szczegóły: [Gateway protocol](/gateway/protocol), [Pairing](/channels/pairing),
[Security](/gateway/security).

## Typowanie protokołu i generowanie kodu

- Schematy TypeBox definiują protokół.
- JSON Schema jest generowany z tych schematów.
- Modele Swift są generowane z JSON Schema.

## Dostęp zdalny

- Preferowane: Tailscale lub VPN.

- Alternatywa: tunel SSH

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- To samo uzgodnienie + token uwierzytelniania obowiązują przez tunel.

- TLS + opcjonalne pinning można włączyć dla WS w konfiguracjach zdalnych.

## Migawka operacyjna

- Start: `openclaw gateway` (na pierwszym planie, logi do stdout).
- Zdrowie: `health` przez WS (również zawarte w `hello-ok`).
- Nadzór: launchd/systemd do automatycznego restartu.

## Niezmienniki

- Dokładnie jeden Gateway kontroluje jedną sesję Baileys na hosta.
- Uzgodnienie jest obowiązkowe; każda pierwsza ramka nie‑JSON lub inna niż connect skutkuje natychmiastowym zamknięciem.
- Zdarzenia nie są odtwarzane; klienci muszą odświeżać stan po wystąpieniu luk.
