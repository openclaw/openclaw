---
summary: "Wykrywanie węzłów i transporty (Bonjour, Tailscale, SSH) do odnajdywania bramy"
read_when:
  - Implementowanie lub zmiana wykrywania/reklamowania Bonjour
  - Dostosowywanie trybów połączeń zdalnych (bezpośrednio vs SSH)
  - Projektowanie wykrywania węzłów i parowania dla węzłów zdalnych
title: "Wykrywanie i transporty"
---

# Wykrywanie i transporty

OpenClaw ma dwa odrębne problemy, które na pierwszy rzut oka wyglądają podobnie:

1. **Zdalne sterowanie przez operatora**: aplikacja paska menu macOS kontrolująca Gateway uruchomiony gdzie indziej.
2. **Parowanie węzłów**: iOS/Android (oraz przyszłe węzły) odnajdujące Gateway i bezpiecznie parujące się z nim.

Celem projektowym jest utrzymanie całego wykrywania/reklamowania sieciowego w **Node Gateway** (`openclaw gateway`) oraz traktowanie klientów (aplikacja macOS, iOS) wyłącznie jako konsumentów.

## Regulamin

- **Gateway**: pojedynczy, długotrwale działający proces Gateway, który posiada stan (sesje, parowanie, rejestr węzłów) i uruchamia kanały. Większość konfiguracji używa jednego na host; możliwe są izolowane konfiguracje z wieloma Gateway.
- **Gateway WS (płaszczyzna sterowania)**: punkt końcowy WebSocket na `127.0.0.1:18789` domyślnie; może być powiązany z LAN/tailnet za pomocą `gateway.bind`.
- **Bezpośredni transport WS**: punkt końcowy Gateway WS dostępny z LAN/tailnet (bez SSH).
- **Transport SSH (awaryjny)**: zdalne sterowanie przez przekazywanie `127.0.0.1:18789` przez SSH.
- **Starszy most TCP (przestarzały/usunięty)**: starszy transport węzłów (zob. [Bridge protocol](/gateway/bridge-protocol)); nie jest już reklamowany do wykrywania.

Szczegóły protokołów:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Dlaczego utrzymujemy zarówno „bezpośredni”, jak i SSH

- **Bezpośredni WS** zapewnia najlepsze UX w tej samej sieci i w obrębie tailnet:
  - automatyczne wykrywanie w LAN przez Bonjour
  - tokeny parowania i ACL-e zarządzane przez Gateway
  - brak potrzeby dostępu do powłoki; powierzchnia protokołu może pozostać wąska i audytowalna
- **SSH** pozostaje uniwersalnym rozwiązaniem awaryjnym:
  - działa wszędzie tam, gdzie masz dostęp SSH (nawet między niepowiązanymi sieciami)
  - radzi sobie z problemami multicast/mDNS
  - nie wymaga nowych portów przychodzących poza SSH

## Wejścia wykrywania (jak klienci dowiadują się, gdzie jest Gateway)

### 1. Bonjour / mDNS (tylko LAN)

Bonjour działa w trybie best-effort i nie przekracza granic sieci. Jest używany wyłącznie dla wygody w „tej samej sieci LAN”.

Kierunek docelowy:

- **Gateway** reklamuje swój punkt końcowy WS przez Bonjour.
- Klienci przeglądają i wyświetlają listę „wybierz Gateway”, a następnie zapisują wybrany punkt końcowy.

Rozwiązywanie problemów i szczegóły beaconów: [Bonjour](/gateway/bonjour).

#### Szczegóły beaconu usługi

- Typy usług:
  - `_openclaw-gw._tcp` (beacon transportu Gateway)
- Klucze TXT (niejawne):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (lub cokolwiek jest reklamowane)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (tylko gdy TLS jest włączony)
  - `gatewayTlsSha256=<sha256>` (tylko gdy TLS jest włączony i dostępny jest odcisk palca)
  - `canvasPort=18793` (domyślny port hosta canvas; serwuje `/__openclaw__/canvas/`)
  - `cliPath=<path>` (opcjonalne; bezwzględna ścieżka do uruchamialnego punktu wejścia lub binarki `openclaw`)
  - `tailnetDns=<magicdns>` (opcjonalna wskazówka; wykrywana automatycznie, gdy dostępny jest Tailscale)

Wyłączanie/zastępowanie:

- `OPENCLAW_DISABLE_BONJOUR=1` wyłącza reklamowanie.
- `gateway.bind` w `~/.openclaw/openclaw.json` kontroluje tryb powiązania Gateway.
- `OPENCLAW_SSH_PORT` zastępuje port SSH reklamowany w TXT (domyślnie 22).
- `OPENCLAW_TAILNET_DNS` publikuje wskazówkę `tailnetDns` (MagicDNS).
- `OPENCLAW_CLI_PATH` zastępuje reklamowaną ścieżkę CLI.

### 2. Tailnet (między sieciami)

Dla konfiguracji w stylu Londyn/Wiedeń Bonjour nie pomoże. Zalecanym celem „bezpośrednim” jest:

- nazwa MagicDNS Tailscale (preferowana) lub stabilny adres IP w tailnet.

Jeśli Gateway potrafi wykryć, że działa pod Tailscale, publikuje `tailnetDns` jako opcjonalną wskazówkę dla klientów (w tym w beaconach szerokiego zasięgu).

### 3. Cel ręczny / SSH

Gdy nie ma trasy bezpośredniej (lub bezpośrednia jest wyłączona), klienci zawsze mogą połączyć się przez SSH, przekazując port Gateway na local loopback.

Zobacz [Remote access](/gateway/remote).

## Wybór transportu (polityka klienta)

Zalecane zachowanie klienta:

1. Jeśli sparowany bezpośredni punkt końcowy jest skonfigurowany i osiągalny, użyj go.
2. W przeciwnym razie, jeśli Bonjour znajdzie Gateway w LAN, zaoferuj jednorazowy wybór „Użyj tego Gateway” i zapisz go jako bezpośredni punkt końcowy.
3. W przeciwnym razie, jeśli skonfigurowano DNS/IP tailnet, spróbuj bezpośrednio.
4. W przeciwnym razie użyj SSH jako rozwiązania awaryjnego.

## Parowanie i uwierzytelnianie (transport bezpośredni)

Gateway jest źródłem prawdy w zakresie dopuszczania węzłów/klientów.

- Żądania parowania są tworzone/zatwierdzane/odrzucane w Gateway (zob. [Gateway pairing](/gateway/pairing)).
- Gateway egzekwuje:
  - uwierzytelnianie (token / para kluczy)
  - zakresy/ACL-e (Gateway nie jest surowym proxy do każdej metody)
  - limity szybkości

## Odpowiedzialności według komponentu

- **Gateway**: reklamuje beacony wykrywania, podejmuje decyzje parowania i hostuje punkt końcowy WS.
- **Aplikacja macOS**: pomaga wybrać Gateway, pokazuje monity parowania i używa SSH wyłącznie jako rozwiązania awaryjnego.
- **Węzły iOS/Android**: przeglądają Bonjour jako udogodnienie i łączą się z sparowanym Gateway WS.
