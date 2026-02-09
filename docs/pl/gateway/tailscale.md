---
summary: "Zintegrowany Tailscale Serve/Funnel dla panelu Gateway"
read_when:
  - Udostępnianie interfejsu sterowania Gateway poza localhost
  - Automatyzacja dostępu do panelu w tailnecie lub publicznie
title: "Tailscale"
---

# Tailscale (panel Gateway)

OpenClaw może automatycznie konfigurować Tailscale **Serve** (tailnet) lub **Funnel** (publiczny) dla
panelu Gateway oraz portu WebSocket. Dzięki temu Gateway pozostaje powiązany z loopback, a
Tailscale zapewnia HTTPS, routing oraz (dla Serve) nagłówki tożsamości.

## Mody

- `serve`: Serve tylko w tailnecie przez `tailscale serve`. Gateway pozostaje na `127.0.0.1`.
- `funnel`: Publiczny HTTPS przez `tailscale funnel`. OpenClaw wymaga wspólnego hasła.
- `off`: Domyślny (bez automatyzacji Tailscale).

## Uwierzytelnianie

Ustaw `gateway.auth.mode`, aby kontrolować handshake:

- `token` (domyślnie, gdy ustawiono `OPENCLAW_GATEWAY_TOKEN`)
- `password` (wspólny sekret przez `OPENCLAW_GATEWAY_PASSWORD` lub konfigurację)

Gdy `tailscale.mode = "serve"` oraz `gateway.auth.allowTailscale` ma wartość `true`,
prawidłowe żądania proxy Serve mogą uwierzytelniać się za pomocą nagłówków tożsamości Tailscale
(`tailscale-user-login`) bez podawania tokenu/hasła. OpenClaw weryfikuje tożsamość,
rozwiązując adres `x-forwarded-for` przez lokalny demon Tailscale
(`tailscale whois`) i dopasowując go do nagłówka przed akceptacją.
OpenClaw traktuje żądanie jako Serve wyłącznie wtedy, gdy przychodzi z loopback z
nagłówkami Tailscale: `x-forwarded-for`, `x-forwarded-proto` oraz `x-forwarded-host`.
Aby wymagać jawnych poświadczeń, ustaw `gateway.auth.allowTailscale: false` lub
wymuś `gateway.auth.mode: "password"`.

## Przykłady konfiguracji

### Tylko tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Otwórz: `https://<magicdns>/` (lub skonfigurowany `gateway.controlUi.basePath`)

### Tylko tailnet (wiązanie do IP tailnetu)

Użyj tego trybu, gdy chcesz, aby Gateway nasłuchiwał bezpośrednio na IP tailnetu (bez Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Połącz się z innego urządzenia w tailnecie:

- Panel sterowania: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Uwaga: loopback (`http://127.0.0.1:18789`) **nie** będzie działać w tym trybie.

### Publiczny internet (Funnel + wspólne hasło)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Zalecane jest `OPENCLAW_GATEWAY_PASSWORD` zamiast zapisywania hasła na dysku.

## Przykłady CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Uwagi

- Serve/Funnel Tailscale wymaga zainstalowanego i zalogowanego CLI `tailscale`.
- `tailscale.mode: "funnel"` odmawia uruchomienia, jeśli tryb uwierzytelniania nie jest `password`, aby uniknąć publicznej ekspozycji.
- Ustaw `gateway.tailscale.resetOnExit`, jeśli chcesz, aby OpenClaw cofnął konfigurację `tailscale serve`
  lub `tailscale funnel` podczas zamykania.
- `gateway.bind: "tailnet"` to bezpośrednie wiązanie do tailnetu (bez HTTPS, bez Serve/Funnel).
- `gateway.bind: "auto"` preferuje loopback; użyj `tailnet`, jeśli chcesz tylko tailnet.
- Serve/Funnel udostępniają wyłącznie **panel sterowania Gateway + WS**. Węzły łączą się przez
  ten sam punkt końcowy WS Gateway, więc Serve może działać także dla dostępu węzłów.

## Sterowanie przeglądarką (zdalny Gateway + lokalna przeglądarka)

Jeśli uruchamiasz Gateway na jednej maszynie, a chcesz sterować przeglądarką na innej,
uruchom **host węzła** na maszynie z przeglądarką i utrzymuj oba urządzenia w tym samym tailnecie.
Gateway będzie pośredniczył w akcjach przeglądarki do węzła; nie jest potrzebny osobny serwer sterowania ani URL Serve.

Unikaj Funnel do sterowania przeglądarką; traktuj parowanie węzłów jak dostęp operatorski.

## Wymagania wstępne i limity Tailscale

- Serve wymaga włączonego HTTPS dla tailnetu; CLI wyświetli monit, jeśli brakuje tej opcji.
- Serve wstrzykuje nagłówki tożsamości Tailscale; Funnel nie.
- Funnel wymaga Tailscale v1.38.3+, MagicDNS, włączonego HTTPS oraz atrybutu węzła funnel.
- Funnel obsługuje przez TLS wyłącznie porty `443`, `8443` oraz `10000`.
- Funnel na macOS wymaga wariantu aplikacji Tailscale o otwartym kodzie źródłowym.

## Dowiedz się więcej

- Przegląd Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Polecenie `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Przegląd Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Polecenie `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
