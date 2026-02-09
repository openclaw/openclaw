---
summary: "Uruchamiaj OpenClaw w sandboxowanej maszynie wirtualnej macOS (lokalnej lub hostowanej), gdy potrzebujesz izolacji lub iMessage"
read_when:
  - Chcesz odizolować OpenClaw od głównego środowiska macOS
  - Chcesz integracji iMessage (BlueBubbles) w sandboxie
  - Chcesz resetowalne środowisko macOS, które można klonować
  - Chcesz porównać lokalne i hostowane opcje maszyn wirtualnych macOS
title: "Maszyny wirtualne macOS"
---

# OpenClaw na maszynach wirtualnych macOS (sandboxing)

## Zalecany domyślny wariant (dla większości użytkowników)

- **Mały VPS z Linuksem** jako zawsze włączony Gateway i niski koszt. Zobacz [VPS hosting](/vps).
- **Dedykowany sprzęt** (Mac mini lub maszyna z Linuksem), jeśli chcesz pełnej kontroli oraz **adresu IP rezydencyjnego** do automatyzacji przeglądarki. Wiele witryn blokuje adresy IP centrów danych, więc lokalne przeglądanie często działa lepiej.
- **Hybryda:** trzymaj Gateway na tanim VPS, a Maca podłączaj jako **węzeł**, gdy potrzebujesz automatyzacji przeglądarki/UI. Zobacz [Nodes](/nodes) oraz [Gateway remote](/gateway/remote).

Używaj maszyny wirtualnej macOS, gdy konkretnie potrzebujesz funkcji dostępnych tylko w macOS (iMessage/BlueBubbles) albo chcesz ścisłej izolacji od codziennego Maca.

## Opcje maszyn wirtualnych macOS

### Lokalna VM na Macu z Apple Silicon (Lume)

Uruchom OpenClaw w sandboxowanej maszynie wirtualnej macOS na istniejącym Macu z Apple Silicon przy użyciu [Lume](https://cua.ai/docs/lume).

Zapewnia to:

- Pełne środowisko macOS w izolacji (host pozostaje „czysty”)
- Obsługę iMessage przez BlueBubbles (niemożliwe na Linuksie/Windows)
- Natychmiastowy reset dzięki klonowaniu VM
- Brak dodatkowego sprzętu lub kosztów chmury

### Hostowani dostawcy Maców (chmura)

Jeśli chcesz macOS w chmurze, sprawdzą się hostowani dostawcy Maców:

- [MacStadium](https://www.macstadium.com/) (hostowane Maki)
- Inni dostawcy hostowanych Maców również działają; postępuj zgodnie z ich dokumentacją VM + SSH

Gdy masz dostęp SSH do maszyny wirtualnej macOS, przejdź do kroku 6 poniżej.

---

## Szybka ścieżka (Lume, doświadczeni użytkownicy)

1. Zainstaluj Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Ukończ Asystenta konfiguracji, włącz Zdalne logowanie (SSH)
4. `lume run openclaw --no-display`
5. Zaloguj się przez SSH, zainstaluj OpenClaw, skonfiguruj kanały
6. Gotowe

---

## Czego potrzebujesz (Lume)

- Mac z Apple Silicon (M1/M2/M3/M4)
- macOS Sequoia lub nowszy na hoście
- ~60 GB wolnego miejsca na dysku na VM
- ~20 minut

---

## 1. Zainstaluj Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Jeśli `~/.local/bin` nie znajduje się w PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Weryfikacja:

```bash
lume --version
```

Dokumentacja: [Instalacja Lume](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Utwórz maszynę wirtualną macOS

```bash
lume create openclaw --os macos --ipsw latest
```

To pobierze macOS i utworzy VM. Okno VNC otworzy się automatycznie.

Uwaga: Pobieranie może potrwać w zależności od połączenia.

---

## 3. Ukończ Asystenta konfiguracji

W oknie VNC:

1. Wybierz język i region
2. Pomiń Apple ID (lub zaloguj się, jeśli chcesz później iMessage)
3. Utwórz konto użytkownika (zapamiętaj nazwę użytkownika i hasło)
4. Pomiń wszystkie funkcje opcjonalne

Po zakończeniu konfiguracji włącz SSH:

1. Otwórz Ustawienia systemowe → Ogólne → Udostępnianie
2. Włącz „Zdalne logowanie”

---

## 4. Uzyskaj adres IP VM

```bash
lume get openclaw
```

Znajdź adres IP (zwykle `192.168.64.x`).

---

## 5. Zaloguj się do VM przez SSH

```bash
ssh youruser@192.168.64.X
```

Zastąp `youruser` nazwą konta, które utworzyłeś, oraz IP adresem IP Twojej VM.

---

## 6. Zainstaluj OpenClaw

Wewnątrz VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Postępuj zgodnie z monitami onboardingu, aby skonfigurować dostawcę modelu (Anthropic, OpenAI itd.).

---

## 7. Skonfiguruj kanały

Edytuj plik konfiguracyjny:

```bash
nano ~/.openclaw/openclaw.json
```

Dodaj swoje kanały:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Następnie zaloguj się do WhatsApp (zeskanuj kod QR):

```bash
openclaw channels login
```

---

## 8. Uruchom VM bez interfejsu graficznego

Zatrzymaj VM i uruchom ponownie bez wyświetlania:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM działa w tle. Demon OpenClaw utrzymuje gateway w działaniu.

Aby sprawdzić status:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: integracja iMessage

To kluczowa zaleta uruchamiania na macOS. Użyj [BlueBubbles](https://bluebubbles.app), aby dodać iMessage do OpenClaw.

Wewnątrz VM:

1. Pobierz BlueBubbles z bluebubbles.app
2. Zaloguj się przy użyciu Apple ID
3. Włącz Web API i ustaw hasło
4. Skieruj webhooki BlueBubbles do swojego gateway (przykład: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Dodaj do konfiguracji OpenClaw:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Zrestartuj gateway. Teraz agent może wysyłać i odbierać iMessage.

Pełne szczegóły konfiguracji: [Kanał BlueBubbles](/channels/bluebubbles)

---

## Zapisz „złoty” obraz

Przed dalszą personalizacją wykonaj migawkę czystego stanu:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Reset w dowolnym momencie:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Praca 24/7

Utrzymuj VM w działaniu poprzez:

- Trwa podłączanie Maca
- Wyłączenie uśpienia w Ustawieniach systemowych → Oszczędzanie energii
- Użycie `caffeinate`, jeśli to konieczne

Dla prawdziwego trybu zawsze włączonego rozważ dedykowanego Maca mini lub mały VPS. Zobacz [VPS hosting](/vps).

---

## Rozwiązywanie problemów

| Problem                          | Rozwiązanie                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Nie można połączyć się przez SSH | Sprawdź, czy „Zdalne logowanie” jest włączone w Ustawieniach systemowych VM                                             |
| Nie wyświetla się IP VM          | Poczekaj, aż VM w pełni się uruchomi, ponownie uruchom `lume get openclaw`                                              |
| Nie znaleziono polecenia Lume    | Dodaj `~/.local/bin` do PATH                                                                                            |
| Kod QR WhatsApp nie skanuje      | Upewnij się, że jesteś zalogowany do VM (a nie hosta) podczas uruchamiania `openclaw channels login` |

---

## Powiązana dokumentacja

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [Kanał BlueBubbles](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (zaawansowane)
- [Docker Sandboxing](/install/docker) (alternatywne podejście do izolacji)
