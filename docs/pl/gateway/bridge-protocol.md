---
summary: "Protokół Bridge (węzły legacy): TCP JSONL, parowanie, RPC o ograniczonym zakresie"
read_when:
  - Budowanie lub debugowanie klientów węzłów (tryb węzła iOS/Android/macOS)
  - Badanie problemów z parowaniem lub uwierzytelnianiem mostu
  - Audytowanie powierzchni węzła udostępnionej przez gateway
title: "Protokół Bridge"
---

# Protokół Bridge (transport węzłów legacy)

Protokół Bridge to **legacy** transport węzłów (TCP JSONL). Nowe klienty węzłów
powinny zamiast tego używać ujednoliconego protokołu WebSocket Gateway.

Jeśli tworzysz operatora lub klienta węzła, użyj
[protokołu Gateway](/gateway/protocol).

**Uwaga:** Aktualne kompilacje OpenClaw nie dostarczają już nasłuchu mostu TCP; ten dokument jest zachowany wyłącznie w celach historycznych.
Legacy klucze konfiguracyjne `bridge.*` nie są już częścią schematu konfiguracji.

## Dlaczego mamy oba

- **Granica bezpieczeństwa**: most udostępnia niewielką listę dozwolonych zamiast
  pełnej powierzchni API gateway.
- **Parowanie + tożsamość węzła**: dopuszczanie węzłów jest zarządzane przez gateway i powiązane
  z tokenem per węzeł.
- **UX wykrywania**: węzły mogą wykrywać gatewaye przez Bonjour w LAN lub łączyć się
  bezpośrednio przez tailnet.
- **WS na loopback**: pełna płaszczyzna sterowania WS pozostaje lokalna, o ile nie jest tunelowana przez SSH.

## Transport

- TCP, jeden obiekt JSON na linię (JSONL).
- Opcjonalny TLS (gdy `bridge.tls.enabled` ma wartość true).
- Legacy domyślny port nasłuchu wynosił `18790` (bieżące kompilacje nie uruchamiają mostu TCP).

Gdy TLS jest włączony, rekordy TXT wykrywania zawierają `bridgeTls=1` oraz
`bridgeTlsSha256`, aby węzły mogły przypiąć certyfikat.

## Uścisk dłoni + parowanie

1. Klient wysyła `hello` z metadanymi węzła + tokenem (jeśli jest już sparowany).
2. Jeśli nie jest sparowany, gateway odpowiada `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Klient wysyła `pair-request`.
4. Gateway czeka na zatwierdzenie, a następnie wysyła `pair-ok` oraz `hello-ok`.

`hello-ok` zwraca `serverName` i może zawierać `canvasHostUrl`.

## Ramki

Klient → Gateway:

- `req` / `res`: RPC gateway o ograniczonym zakresie (czat, sesje, konfiguracja, zdrowie, voicewake, skills.bins)
- `event`: sygnały węzła (transkrypcja głosu, żądanie agenta, subskrypcja czatu, cykl życia exec)

Gateway → Klient:

- `invoke` / `invoke-res`: polecenia węzła (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: aktualizacje czatu dla subskrybowanych sesji
- `ping` / `pong`: keepalive

Egzekwowanie legacy listy dozwolonych znajdowało się w `src/gateway/server-bridge.ts` (usunięte).

## Zdarzenia cyklu życia exec

Węzły mogą emitować zdarzenia `exec.finished` lub `exec.denied`, aby ujawnić aktywność system.run.
Są one mapowane na zdarzenia systemowe w gateway. (Węzły legacy mogą nadal emitować `exec.started`).

Pola ładunku (wszystkie opcjonalne, o ile nie zaznaczono inaczej):

- `sessionKey` (wymagane): sesja agenta, która ma otrzymać zdarzenie systemowe.
- `runId`: unikalny identyfikator exec do grupowania.
- `command`: surowy lub sformatowany ciąg polecenia.
- `exitCode`, `timedOut`, `success`, `output`: szczegóły zakończenia (tylko zakończone).
- `reason`: powód odmowy (tylko odmówione).

## Użycie tailnet

- Zwiąż most z adresem IP tailnet: `bridge.bind: "tailnet"` w
  `~/.openclaw/openclaw.json`.
- Klienci łączą się przez nazwę MagicDNS lub adres IP tailnet.
- Bonjour **nie** przekracza sieci; w razie potrzeby użyj ręcznego hosta/portu lub szerokoobszarowego DNS‑SD.

## Wersjonowanie

Bridge jest obecnie **implicit v1** (brak negocjacji min/max). Oczekiwana jest zgodność wsteczna; przed jakimikolwiek zmianami niezgodnymi wstecz należy dodać pole wersji protokołu Bridge.
