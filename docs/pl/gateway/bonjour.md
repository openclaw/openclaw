---
summary: "Wykrywanie i debugowanie Bonjour/mDNS (beacony Gateway, klienci i typowe tryby awarii)"
read_when:
  - Debugowanie problemów z wykrywaniem Bonjour na macOS/iOS
  - Zmiana typów usług mDNS, rekordów TXT lub UX wykrywania
title: "Wykrywanie Bonjour"
---

# Wykrywanie Bonjour / mDNS

OpenClaw używa Bonjour (mDNS / DNS‑SD) jako **udogodnienia wyłącznie w LAN**, aby wykrywać
aktywny Gateway (punkt końcowy WebSocket). Jest to mechanizm best‑effort i **nie**
zastępuje łączności przez SSH ani opartej na Tailnet.

## Bonjour szerokiego obszaru (Unicast DNS‑SD) przez Tailscale

Jeśli węzeł i Gateway znajdują się w różnych sieciach, multicast mDNS nie przekroczy
granicy. Możesz zachować ten sam UX wykrywania, przełączając się na **unicast DNS‑SD**
(„Wide‑Area Bonjour”) przez Tailscale.

Kroki na wysokim poziomie:

1. Uruchom serwer DNS na hoście Gateway (osiągalny przez Tailnet).
2. Opublikuj rekordy DNS‑SD dla `_openclaw-gw._tcp` w dedykowanej strefie
   (przykład: `openclaw.internal.`).
3. Skonfiguruj **split DNS** w Tailscale, aby wybrana domena była rozwiązywana przez ten
   serwer DNS dla klientów (w tym iOS).

OpenClaw obsługuje dowolną domenę wykrywania; `openclaw.internal.` to tylko przykład.
Węzły iOS/Android przeglądają zarówno `local.`, jak i skonfigurowaną domenę szerokiego obszaru.

### Konfiguracja Gateway (zalecane)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Jednorazowa konfiguracja serwera DNS (host Gateway)

```bash
openclaw dns setup --apply
```

Instaluje to CoreDNS i konfiguruje go tak, aby:

- nasłuchiwał na porcie 53 wyłącznie na interfejsach Tailscale Gateway
- serwował wybraną domenę (przykład: `openclaw.internal.`) z `~/.openclaw/dns/<domain>.db`

Zweryfikuj z maszyny połączonej z tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Ustawienia DNS w Tailscale

W konsoli administracyjnej Tailscale:

- Dodaj serwer nazw wskazujący na adres IP tailnet Gateway (UDP/TCP 53).
- Dodaj split DNS, aby domena wykrywania korzystała z tego serwera nazw.

Gdy klienci zaakceptują DNS tailnet, węzły iOS mogą przeglądać
`_openclaw-gw._tcp` w domenie wykrywania bez multicastu.

### Bezpieczeństwo nasłuchu Gateway (zalecane)

Port WS Gateway (domyślnie `18789`) domyślnie wiąże się z loopback. Dla dostępu LAN/tailnet
wiąż go jawnie i pozostaw włączone uwierzytelnianie.

Dla konfiguracji wyłącznie tailnet:

- Ustaw `gateway.bind: "tailnet"` w `~/.openclaw/openclaw.json`.
- Zrestartuj Gateway (lub zrestartuj aplikację na pasku menu macOS).

## Co jest ogłaszane

Tylko Gateway ogłasza `_openclaw-gw._tcp`.

## Typy usług

- `_openclaw-gw._tcp` — beacon transportowy gateway (używany przez węzły macOS/iOS/Android).

## Klucze TXT (nie‑tajne wskazówki)

Gateway ogłasza niewielkie, nie‑tajne wskazówki, aby usprawnić przepływy UI:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (tylko gdy TLS jest włączony)
- `gatewayTlsSha256=<sha256>` (tylko gdy TLS jest włączony i dostępny jest fingerprint)
- `canvasPort=<port>` (tylko gdy host canvas jest włączony; domyślnie `18793`)
- `sshPort=<port>` (domyślnie 22, gdy nie nadpisano)
- `transport=gateway`
- `cliPath=<path>` (opcjonalne; ścieżka bezwzględna do uruchamialnego punktu wejścia `openclaw`)
- `tailnetDns=<magicdns>` (opcjonalna wskazówka, gdy Tailnet jest dostępny)

## Debugowanie na macOS

Przydatne wbudowane narzędzia:

- Przeglądanie instancji:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Rozwiązywanie jednej instancji (zastąp `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Jeśli przeglądanie działa, ale rozwiązywanie nie, zwykle oznacza to politykę LAN lub
problem z resolverem mDNS.

## Debugowanie w logach Gateway

Gateway zapisuje rotujący plik logów (drukowany przy starcie jako
`gateway log file: ...`). Szukaj linii `bonjour:`, w szczególności:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Debugowanie na węźle iOS

Węzeł iOS używa `NWBrowser` do wykrywania `_openclaw-gw._tcp`.

Aby zebrać logi:

- Ustawienia → Gateway → Zaawansowane → **Logi debugowania wykrywania**
- Ustawienia → Gateway → Zaawansowane → **Logi wykrywania** → odtwórz → **Kopiuj**

Log zawiera przejścia stanów przeglądarki i zmiany zestawu wyników.

## Typowe tryby awarii

- **Bonjour nie przekracza granic sieci**: użyj Tailnet lub SSH.
- **Multicast zablokowany**: niektóre sieci Wi‑Fi wyłączają mDNS.
- **Uśpienie / zmiany interfejsów**: macOS może tymczasowo tracić wyniki mDNS; ponów próbę.
- **Przeglądanie działa, ale rozwiązywanie nie**: utrzymuj proste nazwy maszyn (unikaj emoji lub
  interpunkcji), a następnie zrestartuj Gateway. Nazwa instancji usługi pochodzi od
  nazwy hosta, więc zbyt złożone nazwy mogą dezorientować niektóre resolvery.

## Ucieczkowe nazwy instancji (`\032`)

Bonjour/DNS‑SD często ucieka bajty w nazwach instancji usług jako dziesiętne sekwencje
`\DDD` (np. spacje stają się `\032`).

- Jest to normalne na poziomie protokołu.
- Interfejsy UI powinny dekodować do wyświetlania (iOS używa `BonjourEscapes.decode`).

## Wyłączanie / konfiguracja

- `OPENCLAW_DISABLE_BONJOUR=1` wyłącza ogłaszanie (starsze: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` w `~/.openclaw/openclaw.json` kontroluje tryb wiązania Gateway.
- `OPENCLAW_SSH_PORT` nadpisuje port SSH ogłaszany w TXT (starsze: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publikuje wskazówkę MagicDNS w TXT (starsze: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` nadpisuje ogłaszaną ścieżkę CLI (starsze: `OPENCLAW_CLI_PATH`).

## Powiązana dokumentacja

- Polityka wykrywania i wybór transportu: [Discovery](/gateway/discovery)
- Parowanie węzłów + zatwierdzenia: [Gateway pairing](/gateway/pairing)
