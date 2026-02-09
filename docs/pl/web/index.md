---
summary: "Powierzchnie webowe Gateway: interfejs sterowania, tryby bindowania i bezpieczeństwo"
read_when:
  - Chcesz uzyskać dostęp do Gateway przez Tailscale
  - Chcesz używać przeglądarkowego interfejsu Control UI i edycji konfiguracji
title: "Web"
---

# Web (Gateway)

Gateway udostępnia niewielki **przeglądarkowy Control UI** (Vite + Lit) z tego samego portu co WebSocket Gateway:

- domyślnie: `http://<host>:18789/`
- opcjonalny prefiks: ustaw `gateway.controlUi.basePath` (np. `/openclaw`)

Możliwości są opisane w [Control UI](/web/control-ui).
Ta strona koncentruje się na trybach bindowania, bezpieczeństwie oraz powierzchniach dostępnych z poziomu WWW.

## Webhooki

Gdy `hooks.enabled=true`, Gateway udostępnia także niewielki endpoint webhooka na tym samym serwerze HTTP.
Zobacz [Konfiguracja Gateway](/gateway/configuration) → `hooks` w zakresie uwierzytelniania i ładunków.

## Konfiguracja (domyślnie włączona)

Control UI jest **włączony domyślnie**, gdy zasoby są obecne (`dist/control-ui`).
Można nim sterować poprzez konfigurację:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Dostęp przez Tailscale

### Zintegrowany Serve (zalecane)

Pozostaw Gateway na local loopback i pozwól, aby Tailscale Serve pośredniczył w dostępie:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Następnie uruchom gateway:

```bash
openclaw gateway
```

Otwórz:

- `https://<magicdns>/` (lub skonfigurowany `gateway.controlUi.basePath`)

### Bind do tailnet + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Następnie uruchom gateway (wymagany token dla bindów innych niż loopback):

```bash
openclaw gateway
```

Otwórz:

- `http://<tailscale-ip>:18789/` (lub skonfigurowany `gateway.controlUi.basePath`)

### Publiczny internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Uwagi dotyczące bezpieczeństwa

- Uwierzytelnianie Gateway jest wymagane domyślnie (token/hasło lub nagłówki tożsamości Tailscale).
- Bindowanie poza loopback nadal **wymaga** współdzielonego tokenu/hasła (`gateway.auth` lub zmienna środowiskowa).
- Kreator generuje token gateway domyślnie (nawet na loopback).
- UI wysyła `connect.params.auth.token` lub `connect.params.auth.password`.
- Control UI wysyła nagłówki anti-clickjacking i akceptuje wyłącznie połączenia WebSocket z tej samej domeny przeglądarki, chyba że ustawiono `gateway.controlUi.allowedOrigins`.
- Przy Serve nagłówki tożsamości Tailscale mogą spełnić wymagania uwierzytelniania, gdy
  `gateway.auth.allowTailscale` ma wartość `true` (token/hasło nie są wymagane). Ustaw
  `gateway.auth.allowTailscale: false`, aby wymagać jawnych poświadczeń. Zobacz
  [Tailscale](/gateway/tailscale) oraz [Bezpieczeństwo](/gateway/security).
- `gateway.tailscale.mode: "funnel"` wymaga `gateway.auth.mode: "password"` (współdzielone hasło).

## Budowanie interfejsu

Gateway serwuje pliki statyczne z `dist/control-ui`. Zbuduj je poleceniem:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
