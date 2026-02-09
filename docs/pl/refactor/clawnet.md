---
summary: "Refaktoryzacja Clawnet: ujednolicenie protokołu sieciowego, ról, uwierzytelniania, zatwierdzeń i tożsamości"
read_when:
  - Planowanie ujednoliconego protokołu sieciowego dla węzłów + klientów operatora
  - Przebudowa zatwierdzeń, parowania, TLS i obecności między urządzeniami
title: "Refaktoryzacja Clawnet"
---

# Refaktoryzacja Clawnet (ujednolicenie protokołu + uwierzytelniania)

## Cześć

Cześć Peter — świetny kierunek; to odblokowuje prostszy UX + silniejsze bezpieczeństwo.

## Cel

Jeden, rygorystyczny dokument dla:

- Stanu obecnego: protokoły, przepływy, granice zaufania.
- Problemów: zatwierdzenia, routowanie wieloskokowe, duplikacja UI.
- Proponowanego nowego stanu: jeden protokół, role o określonym zakresie, ujednolicone uwierzytelnianie/parowanie, pinning TLS.
- Modelu tożsamości: stabilne identyfikatory + „urocze” slugy.
- Planu migracji, ryzyk, otwartych pytań.

## Cele (z dyskusji)

- Jeden protokół dla wszystkich klientów (aplikacja na macOS, CLI, iOS, Android, węzeł headless).
- Każdy uczestnik sieci uwierzytelniony + sparowany.
- Jasność ról: węzły vs operatorzy.
- Centralne zatwierdzenia kierowane tam, gdzie jest użytkownik.
- Szyfrowanie TLS + opcjonalny pinning dla całego ruchu zdalnego.
- Minimalna duplikacja kodu.
- Jedna maszyna powinna pojawiać się raz (brak duplikatów UI/węzła).

## Niecele (bezpośrednie)

- Usunięcie separacji możliwości (nadal potrzebna zasada najmniejszych uprawnień).
- Ujawnienie pełnej płaszczyzny sterowania gateway bez kontroli zakresów.
- Uzależnienie uwierzytelniania od etykiet dla ludzi (slugy pozostają nie‑bezpieczeństwowe).

---

# Stan obecny (as‑is)

## Dwa protokoły

### 1. Gateway WebSocket (płaszczyzna sterowania)

- Pełna powierzchnia API: konfiguracja, kanały, modele, sesje, uruchomienia agentów, logi, węzły itd.
- Domyślne wiązanie: loopback. Dostęp zdalny przez SSH/Tailscale.
- Uwierzytelnianie: token/hasło przez `connect`.
- Brak pinningu TLS (polega na loopback/tunelu).
- Kod:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (transport węzłów)

- Wąska powierzchnia z listą dozwolonych, tożsamość węzła + parowanie.
- JSONL przez TCP; opcjonalnie TLS + pinning odcisku certyfikatu.
- TLS ogłasza odcisk w TXT wykrywania.
- Kod:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Klienci płaszczyzny sterowania dziś

- CLI → Gateway WS przez `callGateway` (`src/gateway/call.ts`).
- UI aplikacji na macOS → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Sterowanie w przeglądarce używa własnego serwera HTTP.

## Węzły dziś

- Aplikacja na macOS w trybie węzła łączy się z Bridge Gateway (`MacNodeBridgeSession`).
- Aplikacje iOS/Android łączą się z Bridge Gateway.
- Parowanie + token per węzeł przechowywane w gateway.

## Obecny przepływ zatwierdzeń (exec)

- Agent używa `system.run` przez Gateway.
- Gateway wywołuje węzeł przez bridge.
- Środowisko uruchomieniowe węzła decyduje o zatwierdzeniu.
- Monit UI wyświetlany przez aplikację na macOS (gdy węzeł == aplikacja na macOS).
- Węzeł zwraca `invoke-res` do Gateway.
- Wieloskokowość, UI powiązane z hostem węzła.

## Obecność + tożsamość dziś

- Wpisy obecności Gateway z klientów WS.
- Wpisy obecności węzłów z bridge.
- Aplikacja na macOS może pokazywać dwa wpisy dla tej samej maszyny (UI + węzeł).
- Tożsamość węzła przechowywana w magazynie parowania; tożsamość UI osobno.

---

# Problemy / punkty bólu

- Dwie stosy protokołów do utrzymania (WS + Bridge).
- Zatwierdzenia na zdalnych węzłach: monit pojawia się na hoście węzła, a nie tam, gdzie jest użytkownik.
- Pinning TLS istnieje tylko dla bridge; WS polega na SSH/Tailscale.
- Duplikacja tożsamości: ta sama maszyna widoczna jako wiele instancji.
- Niejednoznaczne role: możliwości UI + węzła + CLI nie są jasno rozdzielone.

---

# Proponowany nowy stan (Clawnet)

## Jeden protokół, dwie role

Jeden protokół WS z rolą + zakresem.

- **Rola: węzeł** (host możliwości)
- **Rola: operator** (płaszczyzna sterowania)
- Opcjonalny **zakres** dla operatora:
  - `operator.read` (status + podgląd)
  - `operator.write` (uruchamianie agenta, wysyłanie)
  - `operator.admin` (konfiguracja, kanały, modele)

### Zachowanie roli

**Węzeł**

- Może rejestrować możliwości (`caps`, `commands`, uprawnienia).
- Może odbierać polecenia `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record` itd.).
- Może wysyłać zdarzenia: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Nie może wywoływać API płaszczyzny sterowania: konfiguracja/modele/kanały/sesje/agent.

**Operator**

- Pełne API płaszczyzny sterowania, ograniczone zakresem.
- Otrzymuje wszystkie zatwierdzenia.
- Nie wykonuje bezpośrednio działań OS; trasuje je do węzłów.

### Kluczowa zasada

Rola jest per połączenie, nie per urządzenie. Urządzenie może otwierać obie role, oddzielnie.

---

# Ujednolicone uwierzytelnianie + parowanie

## Tożsamość klienta

Każdy klient dostarcza:

- `deviceId` (stabilny, wywiedziony z klucza urządzenia).
- `displayName` (nazwa czytelna dla człowieka).
- `role` + `scope` + `caps` + `commands`.

## Przepływ parowania (ujednolicony)

- Klient łączy się bez uwierzytelnienia.
- Gateway tworzy **żądanie parowania** dla tego `deviceId`.
- Operator otrzymuje monit; zatwierdza/odrzuca.
- Gateway wydaje poświadczenia powiązane z:
  - kluczem publicznym urządzenia
  - rolą(-ami)
  - zakresem(-ami)
  - możliwościami/poleceniami
- Klient zapisuje token i łączy się ponownie jako uwierzytelniony.

## Uwierzytelnianie powiązane z urządzeniem (uniknięcie replay tokenów typu bearer)

Preferowane: pary kluczy urządzenia.

- Urządzenie generuje parę kluczy jednorazowo.
- `deviceId = fingerprint(publicKey)`.
- Gateway wysyła nonce; urządzenie podpisuje; gateway weryfikuje.
- Tokeny są wydawane na klucz publiczny (dowód posiadania), a nie na ciąg znaków.

Alternatywy:

- mTLS (certyfikaty klienckie): najsilniejsze, większa złożoność operacyjna.
- Krótkotrwałe tokeny bearer tylko jako faza przejściowa (szybka rotacja + wczesna rewokacja).

## Ciche zatwierdzanie (heurystyka SSH)

Zdefiniować precyzyjnie, aby uniknąć słabego ogniwa. Preferować jedno:

- **Tylko lokalnie**: automatyczne parowanie, gdy klient łączy się przez loopback/gniazdo Unix.
- **Wyzwanie przez SSH**: gateway wydaje nonce; klient dowodzi SSH, pobierając je.
- **Okno fizycznej obecności**: po lokalnym zatwierdzeniu w UI hosta gateway, zezwolić na auto‑parowanie przez krótki czas (np. 10 minut).

Zawsze logować i rejestrować auto‑zatwierdzenia.

---

# TLS wszędzie (dev + prod)

## Ponowne użycie istniejącego TLS bridge

Użyć obecnego środowiska TLS + pinningu odcisku:

- `src/infra/bridge/server/tls.ts`
- logika weryfikacji odcisku w `src/node-host/bridge-client.ts`

## Zastosowanie do WS

- Serwer WS obsługuje TLS z tym samym certyfikatem/kluczem + odciskiem.
- Klienci WS mogą przypinać odcisk (opcjonalnie).
- Wykrywanie ogłasza TLS + odcisk dla wszystkich punktów końcowych.
  - Wykrywanie to wyłącznie wskazówki lokalizacyjne; nigdy kotwica zaufania.

## Dlaczego

- Zmniejszyć zależność od SSH/Tailscale dla poufności.
- Uczynić zdalne połączenia mobilne bezpiecznymi domyślnie.

---

# Przebudowa zatwierdzeń (centralizacja)

## Obecnie

Zatwierdzenie odbywa się na hoście węzła (środowisko węzła aplikacji na macOS). Monit pojawia się tam, gdzie działa węzeł.

## Propozycja

Zatwierdzenie jest **hostowane w gateway**, a UI dostarczane do klientów operatora.

### Nowy przepływ

1. Gateway otrzymuje zamiar `system.run` (agent).
2. Gateway tworzy rekord zatwierdzenia: `approval.requested`.
3. UI operatora wyświetlają monit.
4. Decyzja zatwierdzenia wysyłana do gateway: `approval.resolve`.
5. Gateway wywołuje polecenie węzła, jeśli zatwierdzono.
6. Węzeł wykonuje i zwraca `invoke-res`.

### Semantyka zatwierdzeń (utwardzenie)

- Rozgłoszenie do wszystkich operatorów; tylko aktywne UI pokazuje modal (pozostałe dostają toast).
- Wygrywa pierwsze rozstrzygnięcie; gateway odrzuca kolejne jako już rozstrzygnięte.
- Domyślny timeout: odmowa po N sekundach (np. 60 s), z logowaniem przyczyny.
- Rozstrzygnięcie wymaga zakresu `operator.approvals`.

## Korzyści

- Monit pojawia się tam, gdzie jest użytkownik (mac/telefon).
- Spójne zatwierdzenia dla zdalnych węzłów.
- Środowisko węzła pozostaje headless; brak zależności od UI.

---

# Przykłady jasności ról

## Aplikacja na iPhone

- **Rola węzła** dla: mikrofonu, kamery, czatu głosowego, lokalizacji, push‑to‑talk.
- Opcjonalny **operator.read** dla statusu i widoku czatu.
- Opcjonalny **operator.write/admin** tylko po wyraźnym włączeniu.

## Aplikacja na macOS

- Domyślnie rola operatora (UI sterowania).
- Rola węzła po włączeniu „Mac node” (system.run, ekran, kamera).
- Ten sam deviceId dla obu połączeń → scalony wpis UI.

## CLI

- Zawsze rola operatora.
- Zakres wywodzony z podkomendy:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - zatwierdzenia + parowanie → `operator.approvals` / `operator.pairing`

---

# Tożsamość + slugy

## Stabilny identyfikator

Wymagany do uwierzytelniania; nigdy się nie zmienia.
Preferowane:

- Odcisk pary kluczy (hash klucza publicznego).

## Słodki lug (temat)

Tylko etykieta dla ludzi.

- Przykład: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Przechowywany w rejestrze gateway, edytowalny.
- Obsługa kolizji: `-2`, `-3`.

## Grupowanie w UI

Ten sam `deviceId` w różnych rolach → jeden wiersz „Instancja”:

- Odznaka: `operator`, `node`.
- Pokazuje możliwości + ostatnio widziany.

---

# Strategia migracji

## Faza 0: Dokument + uzgodnienie

- Opublikować ten dokument.
- Zinwentaryzować wszystkie wywołania protokołu + przepływy zatwierdzeń.

## Faza 1: Dodać role/zakresy do WS

- Rozszerzyć parametry `connect` o `role`, `scope`, `deviceId`.
- Dodać bramkowanie listy dozwolonych dla roli węzła.

## Faza 2: Zgodność z Bridge

- Utrzymać działanie bridge.
- Dodać wsparcie węzła WS równolegle.
- Ukryć funkcje za flagą konfiguracyjną.

## Faza 3: Centralne zatwierdzenia

- Dodać zdarzenia żądania + rozstrzygnięcia zatwierdzeń w WS.
- Zaktualizować UI aplikacji na macOS, aby wyświetlała monity + odpowiadała.
- Node runtime zatrzymuje wywoływanie interfejsu użytkownika.

## Faza 4: Ujednolicenie TLS

- Dodać konfigurację TLS dla WS, używając środowiska TLS bridge.
- Dodać pinning po stronie klientów.

## Faza 5: Wycofanie bridge

- Przenieść iOS/Android/węzeł macOS na WS.
- Zostawić bridge jako fallback; usunąć po ustabilizowaniu.

## Faza 6: Uwierzytelnianie powiązane z urządzeniem

- Wymagać tożsamości opartej na kluczach dla wszystkich połączeń nielokalnych.
- Dodać UI do rewokacji + rotacji.

---

# Uwagi dotyczące bezpieczeństwa

- Role/listy dozwolonych egzekwowane na granicy gateway.
- Żaden klient nie otrzymuje „pełnego” API bez zakresu operatora.
- Parowanie wymagane dla _wszystkich_ połączeń.
- TLS + pinning redukują ryzyko MITM dla urządzeń mobilnych.
- Ciche zatwierdzanie przez SSH to wygoda; nadal rejestrowane + możliwe do cofnięcia.
- Wykrywanie nigdy nie jest kotwicą zaufania.
- Deklaracje możliwości są weryfikowane względem list dozwolonych serwera według platformy/typu.

# Strumieniowanie + duże ładunki (media węzłów)

Płaszczyzna sterowania WS jest dobra dla małych komunikatów, ale węzły wykonują też:

- klipy z kamery
- nagrania ekranu
- strumienie audio

Opcje:

1. Ramki binarne WS + porcjowanie + zasady backpressure.
2. Oddzielny punkt końcowy strumieniowania (nadal TLS + uwierzytelnianie).
3. Dłużej utrzymać bridge dla poleceń intensywnie medialnych, migrować na końcu.

Wybrać jedną opcję przed implementacją, aby uniknąć dryfu.

# Polityka możliwości + poleceń

- Zgłaszane przez węzeł możliwości/polecenia są traktowane jako **deklaracje**.
- Gateway egzekwuje listy dozwolonych per platforma.
- Każde nowe polecenie wymaga zatwierdzenia operatora lub jawnej zmiany listy dozwolonych.
- Zmiany audytowane z sygnaturami czasu.

# Audyt + limitowanie szybkości

- Logować: żądania parowania, zatwierdzenia/odmowy, wydawanie/rotację/revokację tokenów.
- Ograniczać spam parowania i monity zatwierdzeń.

# Higiena protokołu

- Jawna wersja protokołu + kody błędów.
- Zasady ponownego łączenia + polityka heartbeat.
- TTL obecności i semantyka „ostatnio widziany”.

---

# Otwarte pytania

1. Jedno urządzenie uruchamiające obie role: model tokenów
   - Zalecane osobne tokeny per rola (węzeł vs operator).
   - Ten sam deviceId; różne zakresy; czytelniejsza rewokacja.

2. Granularność zakresów operatora
   - read/write/admin + zatwierdzenia + parowanie (minimum).
   - Rozważyć zakresy per funkcja później.

3. UX rotacji + rewokacji tokenów
   - Automatyczna rotacja przy zmianie roli.
   - UI do cofania według deviceId + rola.

4. Wykrywanie
   - Rozszerzyć obecne TXT Bonjour o odcisk TLS WS + wskazówki ról.
   - Traktować wyłącznie jako wskazówki lokalizacyjne.

5. Zatwierdzenia między sieciami
   - Rozgłaszać do wszystkich klientów operatora; aktywne UI pokazuje modal.
   - Wygrywa pierwsza odpowiedź; gateway egzekwuje atomowość.

---

# Podsumowanie (TL;DR)

- Dziś: płaszczyzna sterowania WS + transport węzłów Bridge.
- Problemy: zatwierdzenia + duplikacja + dwa stosy.
- Propozycja: jeden protokół WS z jawnymi rolami + zakresami, ujednolicone parowanie + pinning TLS, zatwierdzenia hostowane w gateway, stabilne identyfikatory urządzeń + „urocze” slugy.
- Rezultat: prostszy UX, silniejsze bezpieczeństwo, mniej duplikacji, lepsze routowanie mobilne.
