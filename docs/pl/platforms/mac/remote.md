---
summary: "„Przepływ aplikacji macOS do sterowania zdalną bramą OpenClaw przez SSH”"
read_when:
  - Konfiguracja lub debugowanie zdalnego sterowania macOS
title: "„Zdalne sterowanie”"
---

# Zdalny OpenClaw (macOS ⇄ host zdalny)

Ten przepływ pozwala aplikacji macOS działać jako pełnoprawny pilot zdalnego sterowania dla bramy OpenClaw uruchomionej na innym hoście (komputer stacjonarny/serwer). Jest to funkcja aplikacji **Remote over SSH** (uruchomienie zdalne). Wszystkie funkcje — kontrole stanu, przekazywanie Voice Wake oraz Web Chat — wykorzystują tę samą zdalną konfigurację SSH z _Ustawienia → Ogólne_.

## Mody

- **Lokalnie (ten Mac)**: Wszystko działa na laptopie. Bez użycia SSH.
- **Remote over SSH (domyślne)**: Polecenia OpenClaw są wykonywane na hoście zdalnym. Aplikacja mac otwiera połączenie SSH z `-o BatchMode` oraz wybraną tożsamością/kluczem i lokalnym przekierowaniem portów.
- **Remote direct (ws/wss)**: Bez tunelu SSH. Aplikacja mac łączy się bezpośrednio z adresem URL Gateway (np. przez Tailscale Serve lub publiczny reverse proxy HTTPS).

## Transporty zdalne

Tryb zdalny obsługuje dwa transporty:

- **Tunel SSH** (domyślny): Używa `ssh -N -L ...` do przekierowania portu Gateway na localhost. Gateway będzie widział adres IP węzła jako `127.0.0.1`, ponieważ tunel jest pętlą zwrotną.
- **Bezpośrednio (ws/wss)**: Łączy się bezpośrednio z adresem URL Gateway. Gateway widzi rzeczywisty adres IP klienta.

## Prereqs na zdalnym hoście

1. Zainstaluj Node + pnpm oraz zbuduj/zainstaluj CLI OpenClaw (`pnpm install && pnpm build && pnpm link --global`).
2. Upewnij się, że `openclaw` jest na PATH dla powłok nieinteraktywnych (w razie potrzeby utwórz dowiązanie do `/usr/local/bin` lub `/opt/homebrew/bin`).
3. Otwórz SSH z uwierzytelnianiem kluczem. Zalecamy adresy IP **Tailscale** dla stabilnej dostępności poza LAN.

## Konfiguracja aplikacji macOS

1. Otwórz _Ustawienia → Ogólne_.
2. W sekcji **OpenClaw runs** wybierz **Remote over SSH** i ustaw:
   - **Transport**: **SSH tunnel** lub **Direct (ws/wss)**.
   - **SSH target**: `user@host` (opcjonalnie `:port`).
     - Jeśli Gateway znajduje się w tej samej sieci LAN i ogłasza Bonjour, wybierz go z listy wykrytych, aby automatycznie uzupełnić to pole.
   - **Gateway URL** (tylko Direct): `wss://gateway.example.ts.net` (lub `ws://...` dla lokalnie/LAN).
   - **Identity file** (zaawansowane): ścieżka do klucza.
   - **Project root** (zaawansowane): zdalna ścieżka repozytorium używana przez polecenia.
   - **CLI path** (zaawansowane): opcjonalna ścieżka do uruchamialnego punktu wejścia/binarki `openclaw` (automatycznie uzupełniana, gdy jest ogłaszana).
3. Kliknij **Test remote**. Sukces oznacza, że zdalny `openclaw status --json` działa poprawnie. Niepowodzenia zwykle oznaczają problemy z PATH/CLI; kod wyjścia 127 oznacza, że CLI nie zostało znalezione zdalnie.
4. Kontrole stanu i Web Chat będą teraz automatycznie działać przez ten tunel SSH.

## Web Chat

- **Tunel SSH**: Web Chat łączy się z Gateway przez przekierowany port sterujący WebSocket (domyślnie 18789).
- **Bezpośrednio (ws/wss)**: Web Chat łączy się bezpośrednio z skonfigurowanym adresem URL Gateway.
- Nie ma już osobnego serwera HTTP WebChat.

## Permissions

- Host zdalny wymaga tych samych zgód TCC co lokalny (Automatyzacja, Dostępność, Nagrywanie ekranu, Mikrofon, Rozpoznawanie mowy, Powiadomienia). Uruchom onboarding na tej maszynie, aby przyznać je jednorazowo.
- Węzły ogłaszają swój stan uprawnień przez `node.list` / `node.describe`, aby agenci wiedzieli, co jest dostępne.

## Uwagi dotyczące bezpieczeństwa

- Preferuj wiązania loopback na hoście zdalnym i łącz się przez SSH lub Tailscale.
- Jeśli powiążesz Gateway z interfejsem innym niż loopback, wymagaj uwierzytelniania tokenem/hasłem.
- Zobacz [Security](/gateway/security) oraz [Tailscale](/gateway/tailscale).

## Przepływ logowania WhatsApp (zdalnie)

- Uruchom `openclaw channels login --verbose` **na hoście zdalnym**. Zeskanuj kod QR w WhatsApp na telefonie.
- Uruchom ponownie logowanie na tym hoście, jeśli uwierzytelnienie wygaśnie. Kontrola stanu wskaże problemy z połączeniem.

## Rozwiązywanie problemów

- **exit 127 / not found**: `openclaw` nie znajduje się na PATH dla powłok nie-logowania. Dodaj go do `/etc/paths`, plików rc powłoki lub utwórz dowiązanie do `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: sprawdź dostępność SSH, PATH oraz czy Baileys jest zalogowany (`openclaw status --json`).
- **Web Chat utknął**: potwierdź, że Gateway działa na hoście zdalnym i że przekierowany port odpowiada portowi WS Gateway; interfejs wymaga zdrowego połączenia WS.
- **Node IP pokazuje 127.0.0.1**: oczekiwane przy tunelu SSH. Przełącz **Transport** na **Direct (ws/wss)**, jeśli chcesz, aby Gateway widział rzeczywisty adres IP klienta.
- **Voice Wake**: frazy wyzwalające są przekazywane automatycznie w trybie zdalnym; nie jest potrzebny osobny forwarder.

## Dźwięki powiadomień

Wybieraj dźwięki dla każdego powiadomienia ze skryptów za pomocą `openclaw` i `node.invoke`, np.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

W aplikacji nie ma już globalnego przełącznika „domyślny dźwięk”; wywołujący wybierają dźwięk (lub brak) dla każdego żądania.
