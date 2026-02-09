---
summary: "„Polecenie Doctor: kontrole zdrowia, migracje konfiguracji i kroki naprawcze”"
read_when:
  - Dodawanie lub modyfikowanie migracji Doctor
  - Wprowadzanie niekompatybilnych zmian konfiguracji
title: "Doctor"
---

# Doctor

`openclaw doctor` to narzędzie naprawcze + migracyjne dla OpenClaw. Naprawia
zastaną konfigurację/stan, sprawdza kondycję i dostarcza konkretne kroki naprawcze.

## Szybki start

```bash
openclaw doctor
```

### Tryb bezgłowy / automatyzacja

```bash
openclaw doctor --yes
```

Akceptuj ustawienia domyślne bez monitów (w tym kroki naprawcze restartu/usługi/sandbox, gdy ma to zastosowanie).

```bash
openclaw doctor --repair
```

Zastosuj zalecane naprawy bez monitów (naprawy + restarty tam, gdzie to bezpieczne).

```bash
openclaw doctor --repair --force
```

Zastosuj również agresywne naprawy (nadpisuje niestandardowe konfiguracje supervisora).

```bash
openclaw doctor --non-interactive
```

Uruchom bez monitów i zastosuj tylko bezpieczne migracje (normalizacja konfiguracji + przenoszenie stanu na dysku). Pomija działania restartu/usługi/sandbox wymagające potwierdzenia człowieka.
Migracje starszego stanu uruchamiają się automatycznie po wykryciu.

```bash
openclaw doctor --deep
```

Skanuj usługi systemowe w poszukiwaniu dodatkowych instalacji gateway (launchd/systemd/schtasks).

Jeśli chcesz przejrzeć zmiany przed zapisem, najpierw otwórz plik konfiguracyjny:

```bash
cat ~/.openclaw/openclaw.json
```

## Co robi (podsumowanie)

- Opcjonalna aktualizacja wstępna dla instalacji git (tylko tryb interaktywny).
- Sprawdzenie świeżości protokołu UI (przebudowuje Control UI, gdy schemat protokołu jest nowszy).
- Kontrola zdrowia + monit o restart.
- Podsumowanie stanu Skills (kwalifikujące się/brakujące/zablokowane).
- Normalizacja konfiguracji dla starszych wartości.
- Ostrzeżenia o nadpisaniach dostawcy OpenCode Zen (`models.providers.opencode`).
- Migracja starszego stanu na dysku (sesje/katalog agenta/uwierzytelnianie WhatsApp).
- Kontrole integralności stanu i uprawnień (sesje, transkrypty, katalog stanu).
- Kontrole uprawnień pliku konfiguracyjnego (chmod 600) przy uruchomieniu lokalnym.
- Kondycja uwierzytelniania modeli: sprawdza wygaśnięcie OAuth, może odświeżać wygasające tokeny oraz raportuje stany cooldown/wyłączone profili uwierzytelniania.
- Wykrywanie dodatkowych katalogów obszaru roboczego (`~/openclaw`).
- Naprawa obrazu sandbox, gdy sandboxing jest włączony.
- Migracja starszych usług i wykrywanie dodatkowych gateway.
- Kontrole czasu działania Gateway (usługa zainstalowana, ale nieuruchomiona; zbuforowana etykieta launchd).
- Ostrzeżenia o stanie kanałów (sondowane z działającego gateway).
- Audyt konfiguracji supervisora (launchd/systemd/schtasks) z opcjonalną naprawą.
- Kontrole najlepszych praktyk czasu działania Gateway (Node vs Bun, ścieżki menedżerów wersji).
- Diagnostyka kolizji portu Gateway (domyślnie `18789`).
- Ostrzeżenia bezpieczeństwa dla otwartych polityk DM.
- Ostrzeżenia uwierzytelniania Gateway, gdy nie ustawiono `gateway.auth.token` (tryb lokalny; oferuje generowanie tokenu).
- Sprawdzenie systemd linger w systemie Linux.
- Kontrole instalacji ze źródeł (niedopasowanie workspace pnpm, brak zasobów UI, brak binarki tsx).
- Zapisuje zaktualizowaną konfigurację + metadane kreatora.

## Szczegółowe zachowanie i uzasadnienie

### 0. Opcjonalna aktualizacja (instalacje git)

Jeśli jest to checkout git i doctor działa interaktywnie, oferuje
aktualizację (fetch/rebase/build) przed uruchomieniem doctor.

### 1. Normalizacja konfiguracji

Jeśli konfiguracja zawiera starsze kształty wartości (na przykład `messages.ackReaction`
bez nadpisania specyficznego dla kanału), doctor normalizuje je do bieżącego
schematu.

### 2. Migracje starszych kluczy konfiguracji

Gdy konfiguracja zawiera przestarzałe klucze, inne polecenia odmawiają działania i proszą
o uruchomienie `openclaw doctor`.

Doctor:

- Wyjaśnia, które starsze klucze zostały znalezione.
- Pokazuje zastosowaną migrację.
- Przepisuje `~/.openclaw/openclaw.json` do zaktualizowanego schematu.

Gateway uruchamia również migracje doctor automatycznie przy starcie, gdy wykryje
starszy format konfiguracji, dzięki czemu przestarzałe konfiguracje są naprawiane
bez ręcznej interwencji.

Aktualne migracje:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → najwyższy poziom `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) Nadpisania dostawcy OpenCode Zen

Jeśli ręcznie dodano `models.providers.opencode` (lub `opencode-zen`), nadpisuje to
wbudowany katalog OpenCode Zen z `@mariozechner/pi-ai`. Może to
wymusić użycie jednego API dla wszystkich modeli lub wyzerować koszty. Doctor ostrzega,
aby można było usunąć nadpisanie i przywrócić per‑modelowe trasowanie API + koszty.

### 3. Migracje starszego stanu (układ na dysku)

Doctor może migrować starsze układy na dysku do bieżącej struktury:

- Magazyn sesji + transkrypty:
  - z `~/.openclaw/sessions/` do `~/.openclaw/agents/<agentId>/sessions/`
- Katalog agenta:
  - z `~/.openclaw/agent/` do `~/.openclaw/agents/<agentId>/agent/`
- Stan uwierzytelniania WhatsApp (Baileys):
  - ze starszego `~/.openclaw/credentials/*.json` (z wyjątkiem `oauth.json`)
  - do `~/.openclaw/credentials/whatsapp/<accountId>/...` (domyślny identyfikator konta: `default`)

Te migracje są best‑effort i idempotentne; doctor emituje ostrzeżenia, gdy pozostawi
jakiekolwiek starsze foldery jako kopie zapasowe. Gateway/CLI automatycznie migruje
również starsze sesje + katalog agenta przy starcie, aby historia/uwierzytelnianie/modele
trafiały do ścieżki per‑agent bez ręcznego uruchamiania doctor. Uwierzytelnianie WhatsApp
jest celowo migrowane wyłącznie przez `openclaw doctor`.

### 4. Kontrole integralności stanu (trwałość sesji, routowanie i bezpieczeństwo)

Katalog stanu to operacyjny „pień mózgu”. Jeśli zniknie, tracisz
sesje, poświadczenia, logi i konfigurację (chyba że masz kopie zapasowe gdzie indziej).

Doctor sprawdza:

- **Brak katalogu stanu**: ostrzega o katastrofalnej utracie stanu, proponuje odtworzenie
  katalogu i przypomina, że nie może odzyskać brakujących danych.
- **Uprawnienia katalogu stanu**: weryfikuje możliwość zapisu; oferuje naprawę uprawnień
  (i emituje podpowiedź `chown`, gdy wykryto niezgodność właściciela/grupy).
- **Brak katalogów sesji**: `sessions/` i katalog magazynu sesji są
  wymagane do utrwalania historii i unikania awarii `ENOENT`.
- **Niezgodność transkryptów**: ostrzega, gdy ostatnie wpisy sesji nie mają
  plików transkryptów.
- **Główna sesja „JSONL z 1 linią”**: sygnalizuje, gdy główny transkrypt ma tylko jedną
  linię (historia się nie kumuluje).
- **Wiele katalogów stanu**: ostrzega, gdy istnieje wiele folderów `~/.openclaw` w różnych
  katalogach domowych lub gdy `OPENCLAW_STATE_DIR` wskazuje gdzie indziej (historia może
  dzielić się między instalacje).
- **Przypomnienie trybu zdalnego**: jeśli `gateway.mode=remote`, doctor przypomina, aby uruchomić
  go na hoście zdalnym (tam znajduje się stan).
- **Uprawnienia pliku konfiguracyjnego**: ostrzega, jeśli `~/.openclaw/openclaw.json` jest
  czytelny dla grupy/świata i oferuje zaostrzenie do `600`.

### 5. Kondycja uwierzytelniania modeli (wygaśnięcie OAuth)

Doctor sprawdza profile OAuth w magazynie uwierzytelniania, ostrzega o
wygasających/wygasłych tokenach i może je odświeżyć, gdy jest to bezpieczne. Jeśli
profil Anthropic Claude Code jest nieaktualny, sugeruje uruchomienie `claude setup-token`
(lub wklejenie setup-token).
Monity odświeżania pojawiają się tylko w trybie
interaktywnym (TTY); `--non-interactive` pomija próby odświeżania.

Doctor raportuje również profile uwierzytelniania, które są tymczasowo niedostępne z powodu:

- krótkich okresów cooldown (limity szybkości/timeouty/błędy uwierzytelniania)
- dłuższych wyłączeń (problemy z rozliczeniami/kredytem)

### 6. Walidacja modelu Hooks

Jeśli ustawiono `hooks.gmail.model`, doctor weryfikuje referencję modelu względem
katalogu i listy dozwolonych oraz ostrzega, gdy nie da się jej rozwiązać lub jest niedozwolona.

### 7. Naprawa obrazu sandbox

Gdy sandboxing jest włączony, doctor sprawdza obrazy Dockera i oferuje budowę lub
przełączenie na starsze nazwy, jeśli bieżący obraz jest brakujący.

### 8. Migracje usług Gateway i wskazówki sprzątania

Doctor wykrywa starsze usługi gateway (launchd/systemd/schtasks) i
oferuje ich usunięcie oraz instalację usługi OpenClaw z użyciem bieżącego portu gateway. Może też skanować w poszukiwaniu dodatkowych usług podobnych do gateway i wypisywać
wskazówki sprzątania.
Usługi gateway OpenClaw nazwane profilem są traktowane jako
pierwszorzędne i nie są oznaczane jako „dodatkowe”.

### 9. Ostrzeżenia bezpieczeństwa

Doctor emituje ostrzeżenia, gdy dostawca jest otwarty na DM‑y bez listy dozwolonych lub
gdy polityka jest skonfigurowana w niebezpieczny sposób.

### 10. systemd linger (Linux)

Jeśli działa jako usługa użytkownika systemd, doctor upewnia się, że włączono lingering,
aby gateway pozostawał aktywny po wylogowaniu.

### 11. Status Skills

Doctor drukuje krótkie podsumowanie kwalifikujących się/brakujących/zablokowanych Skills
dla bieżącego obszaru roboczego.

### 12. Kontrole uwierzytelniania Gateway (token lokalny)

Doctor ostrzega, gdy na lokalnym gateway brakuje `gateway.auth`, i oferuje
wygenerowanie tokenu. Użyj `openclaw doctor --generate-gateway-token`, aby wymusić
tworzenie tokenu w automatyzacji.

### 13. Kontrola zdrowia Gateway + restart

Doctor uruchamia kontrolę zdrowia i oferuje restart gateway, gdy wygląda na
niezdrowy.

### 14. Ostrzeżenia o stanie kanałów

Jeśli gateway jest zdrowy, doctor uruchamia sondę stanu kanałów i raportuje
ostrzeżenia wraz z sugerowanymi poprawkami.

### 15. Audyt konfiguracji supervisora + naprawa

Doctor sprawdza zainstalowaną konfigurację supervisora (launchd/systemd/schtasks) pod kątem
brakujących lub nieaktualnych domyślnych ustawień (np. zależności network‑online systemd i
opóźnienia restartu). Gdy znajdzie niezgodność, rekomenduje aktualizację i może
przepisać plik usługi/zadanie do bieżących domyślnych ustawień.

Uwagi:

- `openclaw doctor` pyta przed przepisaniem konfiguracji supervisora.
- `openclaw doctor --yes` akceptuje domyślne monity napraw.
- `openclaw doctor --repair` stosuje zalecane poprawki bez monitów.
- `openclaw doctor --repair --force` nadpisuje niestandardowe konfiguracje supervisora.
- Zawsze możesz wymusić pełne przepisanie przez `openclaw gateway install --force`.

### 16. Diagnostyka czasu działania Gateway + portów

Doctor sprawdza czas działania usługi (PID, ostatni status zakończenia) i ostrzega,
gdy usługa jest zainstalowana, ale faktycznie nie działa. Sprawdza też kolizje portów
na porcie gateway (domyślnie `18789`) i raportuje prawdopodobne przyczyny (gateway już
uruchomiony, tunel SSH).

### 17. Najlepsze praktyki czasu działania Gateway

Doctor ostrzega, gdy usługa gateway działa na Bun lub na ścieżce Node zarządzanej przez
menedżer wersji (`nvm`, `fnm`, `volta`, `asdf` itd.). Kanały WhatsApp + Telegram wymagają Node,
a ścieżki menedżerów wersji mogą się psuć po aktualizacjach, ponieważ usługa nie
ładuje inicjalizacji powłoki. Doctor oferuje migrację do systemowej instalacji Node,
gdy jest dostępna (Homebrew/apt/choco).

### 18. Zapis konfiguracji + metadane kreatora

Doctor utrwala wszelkie zmiany konfiguracji i stempluje metadane kreatora, aby
zarejestrować uruchomienie doctor.

### 19. Wskazówki dotyczące obszaru roboczego (kopie zapasowe + system pamięci)

Doctor sugeruje system pamięci obszaru roboczego, gdy go brakuje, i wypisuje wskazówkę
dotyczącą kopii zapasowej, jeśli obszar roboczy nie jest już pod kontrolą git.

Zobacz [/concepts/agent-workspace](/concepts/agent-workspace), aby uzyskać pełny przewodnik po
strukturze obszaru roboczego i kopiach zapasowych git (zalecane prywatne GitHub lub GitLab).
