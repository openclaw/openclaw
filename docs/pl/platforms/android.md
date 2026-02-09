---
summary: "Aplikacja Android (węzeł): runbook połączenia + Canvas/Czat/Kamera"
read_when:
  - Parowanie lub ponowne łączenie węzła Android
  - Debugowanie wykrywania Gateway lub uwierzytelniania na Androidzie
  - Weryfikacja spójności historii czatu między klientami
title: "Aplikacja Android"
---

# Aplikacja Android (Węzeł)

## Migawka wsparcia

- Rola: aplikacja węzła towarzyszącego (Android nie hostuje Gateway).
- Wymagany Gateway: tak (uruchom na macOS, Linux lub Windows przez WSL2).
- Instalacja: [Pierwsze kroki](/start/getting-started) + [Parowanie](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Konfiguracja](/gateway/configuration).
  - Protokoły: [Protokół Gateway](/gateway/protocol) (węzły + płaszczyzna sterowania).

## Kontrola systemu

Kontrola systemu (launchd/systemd) znajduje się na hoście Gateway. Zobacz [Gateway](/gateway).

## Runbook połączenia

Aplikacja węzła Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android łączy się bezpośrednio z WebSocket Gateway (domyślnie `ws://<host>:18789`) i używa parowania należącego do Gateway.

### Wymagania wstępne

- Możesz uruchomić Gateway na „głównej” maszynie.
- Urządzenie/emulator Android może osiągnąć WebSocket gateway:
  - Ta sama sieć LAN z mDNS/NSD, **lub**
  - Ten sam tailnet Tailscale z użyciem Wide-Area Bonjour / unicast DNS-SD (zobacz poniżej), **lub**
  - Ręczne ustawienie hosta/portu gateway (awaryjne)
- Możesz uruchomić CLI (`openclaw`) na maszynie gateway (lub przez SSH).

### 1. Uruchom Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Potwierdź w logach, że widzisz coś w rodzaju:

- `listening on ws://0.0.0.0:18789`

Dla konfiguracji tylko w tailnecie (zalecane dla Wiedeń ⇄ Londyn) zbindować gateway do adresu IP tailnetu:

- Ustaw `gateway.bind: "tailnet"` w `~/.openclaw/openclaw.json` na hoście gateway.
- Zrestartuj Gateway / aplikację paska menu macOS.

### 2. Zweryfikuj wykrywanie (opcjonalne)

Z maszyny gateway:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Więcej uwag dotyczących debugowania: [Bonjour](/gateway/bonjour).

#### Wykrywanie w tailnecie (Wiedeń ⇄ Londyn) przez unicast DNS-SD

Wykrywanie NSD/mDNS na Androidzie nie przechodzi między sieciami. Jeśli węzeł Android i gateway są w różnych sieciach, ale połączone przez Tailscale, użyj Wide-Area Bonjour / unicast DNS-SD:

1. Skonfiguruj strefę DNS-SD (przykład `openclaw.internal.`) na hoście gateway i opublikuj rekordy `_openclaw-gw._tcp`.
2. Skonfiguruj split DNS w Tailscale dla wybranej domeny, wskazując ten serwer DNS.

Szczegóły i przykładowa konfiguracja CoreDNS: [Bonjour](/gateway/bonjour).

### 3. Połącz z Androida

W aplikacji Android:

- Aplikacja utrzymuje połączenie z gateway przez **usługę pierwszoplanową** (stałe powiadomienie).
- Otwórz **Ustawienia**.
- W sekcji **Discovered Gateways** wybierz swój gateway i naciśnij **Connect**.
- Jeśli mDNS jest blokowane, użyj **Advanced → Manual Gateway** (host + port) i **Connect (Manual)**.

Po pierwszym udanym parowaniu Android automatycznie ponownie łączy się przy uruchomieniu:

- Ręczny endpoint (jeśli włączony), w przeciwnym razie
- Ostatnio wykryty gateway (best-effort).

### 4. Zatwierdź parowanie (CLI)

Na maszynie gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Szczegóły parowania: [Parowanie Gateway](/gateway/pairing).

### 5. Sprawdź, czy węzeł jest połączony

- Przez status węzłów:

  ```bash
  openclaw nodes status
  ```

- Przez Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Czat + historia

Arkusz Czat w węźle Android używa **klucza sesji podstawowej** gateway (`main`), więc historia i odpowiedzi są współdzielone z WebChat i innymi klientami:

- Historia: `chat.history`
- Wysyłanie: `chat.send`
- Aktualizacje push (best-effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + kamera

#### Host Canvas Gateway (zalecane dla treści webowych)

Jeśli chcesz, aby węzeł wyświetlał prawdziwe HTML/CSS/JS, które agent może edytować na dysku, skieruj węzeł na host Canvas Gateway.

Uwaga: węzły używają samodzielnego hosta canvas na `canvasHost.port` (domyślnie `18793`).

1. Utwórz `~/.openclaw/workspace/canvas/index.html` na hoście gateway.

2. Przejdź do niego z węzła (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (opcjonalnie): jeśli oba urządzenia są w Tailscale, użyj nazwy MagicDNS lub adresu IP tailnetu zamiast `.local`, np. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Ten serwer wstrzykuje klient live-reload do HTML i przeładowuje przy zmianach plików.
Host A2UI znajduje się pod adresem `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Polecenia Canvas (tylko na pierwszym planie):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (użyj `{"url":""}` lub `{"url":"/"}`, aby wrócić do domyślnego szablonu). `canvas.snapshot` zwraca `{ format, base64 }` (domyślnie `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` — alias starszy)

Polecenia kamery (tylko na pierwszym planie; z kontrolą uprawnień):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Zobacz [Węzeł kamery](/nodes/camera) w celu zapoznania się z parametrami i pomocnikami CLI.
