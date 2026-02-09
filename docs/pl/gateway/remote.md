---
summary: "Zdalny dostęp z użyciem tuneli SSH (Gateway WS) i sieci tailnet"
read_when:
  - Uruchamianie lub rozwiązywanie problemów z konfiguracjami zdalnego gateway
title: "Zdalny dostęp"
---

# Zdalny dostęp (SSH, tunele i sieci tailnet)

To repozytorium obsługuje tryb „zdalnie przez SSH” poprzez utrzymywanie pojedynczego Gateway (mastera) uruchomionego na dedykowanym hoście (desktop/serwer) oraz łączenie z nim klientów.

- Dla **operatorów (Ty / aplikacja na macOS)**: tunelowanie SSH jest uniwersalnym rozwiązaniem awaryjnym.
- Dla **węzłów (iOS/Android oraz przyszłe urządzenia)**: połączenie z **WebSocketem** Gateway (LAN/tailnet lub tunel SSH w razie potrzeby).

## Główna idea

- WebSocket Gateway wiąże się z **loopback** na skonfigurowanym porcie (domyślnie 18789).
- Do użytku zdalnego przekazujesz ten port loopback przez SSH (lub używasz tailnet/VPN i tunelujesz rzadziej).

## Typowe konfiguracje VPN/tailnet (gdzie działa agent)

Traktuj **host Gateway** jako „miejsce, w którym działa agent”. To on posiada sesje, profile uwierzytelniania, kanały i stan.
Twój laptop/desktop (oraz węzły) łączą się z tym hostem.

### 1. Gateway zawsze włączony w Twojej sieci tailnet (VPS lub serwer domowy)

Uruchom Gateway na hoście stałym i uzyskuj do niego dostęp przez **Tailscale** lub SSH.

- **Najlepsze UX:** zachowaj `gateway.bind: "loopback"` i użyj **Tailscale Serve** dla interfejsu Control UI.
- **Fallback:** zachowaj loopback + tunel SSH z dowolnej maszyny, która potrzebuje dostępu.
- **Przykłady:** [exe.dev](/install/exe-dev) (łatwa VM) lub [Hetzner](/install/hetzner) (produkcyjny VPS).

To rozwiązanie jest idealne, gdy laptop często przechodzi w uśpienie, a chcesz, aby agent był zawsze dostępny.

### 2. Domowy desktop uruchamia Gateway, laptop jest zdalnym sterowaniem

Laptop **nie** uruchamia agenta. Łączy się zdalnie:

- Użyj trybu **Remote over SSH** w aplikacji na macOS (Ustawienia → Ogólne → „OpenClaw runs”).
- Aplikacja otwiera i zarządza tunelem, więc WebChat + kontrole stanu „po prostu działają”.

Runbook: [zdalny dostęp na macOS](/platforms/mac/remote).

### 3. Laptop uruchamia Gateway, zdalny dostęp z innych maszyn

Zachowaj Gateway lokalnie, ale wystaw go bezpiecznie:

- Tunel SSH do laptopa z innych maszyn lub
- Udostępnij Control UI przez Tailscale Serve i pozostaw Gateway tylko na loopback.

Przewodnik: [Tailscale](/gateway/tailscale) oraz [Przegląd Web](/web).

## Przepływ poleceń (co uruchamia się gdzie)

Jedna usługa gateway posiada stan + kanały. Węzły są peryferiami.

Przykładowy przepływ (Telegram → węzeł):

- Wiadomość z Telegrama trafia do **Gateway**.
- Gateway uruchamia **agenta** i decyduje, czy wywołać narzędzie w węźle.
- Gateway wywołuje **węzeł** przez WebSocket Gateway (RPC `node.*`).
- Węzeł zwraca wynik; Gateway odsyła odpowiedź do Telegrama.

Uwagi:

- **Węzły nie uruchamiają usługi gateway.** Na jednym hoście powinien działać tylko jeden gateway, chyba że celowo uruchamiasz odizolowane profile (zobacz [Wiele gatewayów](/gateway/multiple-gateways)).
- „Tryb węzła” w aplikacji na macOS to po prostu klient węzła przez WebSocket Gateway.

## Tunel SSH (CLI + narzędzia)

Utwórz lokalny tunel do zdalnego Gateway WS:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Z tunelem w górę:

- `openclaw health` oraz `openclaw status --deep` docierają teraz do zdalnego gateway przez `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` może również wskazywać przekazany URL przez `--url`, gdy jest to potrzebne.

Uwaga: zastąp `18789` swoją skonfigurowaną wartością `gateway.port` (lub `--port`/`OPENCLAW_GATEWAY_PORT`).
Uwaga: gdy przekażesz `--url`, CLI nie korzysta z konfiguracji ani poświadczeń środowiskowych.
Jawnie dołącz `--token` lub `--password`. Brak jawnych poświadczeń jest błędem.

## Domyślne ustawienia zdalne CLI

Możesz zapisać zdalny cel, aby polecenia CLI używały go domyślnie:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Gdy gateway jest dostępny tylko przez loopback, pozostaw URL jako `ws://127.0.0.1:18789` i najpierw otwórz tunel SSH.

## Interfejs czatu przez SSH

WebChat nie używa już osobnego portu HTTP. Interfejs czatu SwiftUI łączy się bezpośrednio z WebSocketem Gateway.

- Przekaż `18789` przez SSH (patrz wyżej), a następnie połącz klientów z `ws://127.0.0.1:18789`.
- Na macOS preferuj tryb „Remote over SSH” w aplikacji, który automatycznie zarządza tunelem.

## Aplikacja na macOS „Remote over SSH”

Aplikacja w pasku menu macOS może obsłużyć tę konfigurację end-to-end (zdalne kontrole stanu, WebChat oraz przekazywanie Voice Wake).

Runbook: [zdalny dostęp na macOS](/platforms/mac/remote).

## Zasady bezpieczeństwa (zdalnie/VPN)

W skrócie: **utrzymuj Gateway tylko na loopback**, chyba że masz pewność, że potrzebujesz bindowania.

- **Loopback + SSH/Tailscale Serve** to najbezpieczniejsza domyślna opcja (brak publicznej ekspozycji).
- **Bindowania poza loopback** (`lan`/`tailnet`/`custom` lub `auto`, gdy loopback jest niedostępny) muszą używać tokenów/hasła uwierzytelniania.
- `gateway.remote.token` jest **wyłącznie** do zdalnych wywołań CLI — **nie** włącza lokalnego uwierzytelniania.
- `gateway.remote.tlsFingerprint` przypina zdalny certyfikat TLS podczas użycia `wss://`.
- **Tailscale Serve** może uwierzytelniać przez nagłówki tożsamości, gdy `gateway.auth.allowTailscale: true`.
  Ustaw na `false`, jeśli zamiast tego chcesz używać tokenów/hasła.
- Traktuj kontrolę w przeglądarce jak dostęp operatora: tylko w obrębie tailnet + świadome parowanie węzłów.

Dogłębnie: [Bezpieczeństwo](/gateway/security).
