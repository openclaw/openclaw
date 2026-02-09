---
summary: "Protokół WebSocket Gateway: handshake, ramki, wersjonowanie"
read_when:
  - Implementacja lub aktualizacja klientów WS Gateway
  - Debugowanie niezgodności protokołu lub problemów z połączeniem
  - Regenerowanie schematów/modeli protokołu
title: "Protokół Gateway"
---

# Protokół Gateway (WebSocket)

Protokół WS Gateway jest **pojedynczą płaszczyzną sterowania + transportem węzłów**
dla OpenClaw. Wszyscy klienci (CLI, interfejs webowy, aplikacja na macOS, węzły
iOS/Android, węzły bezgłowe) łączą się przez WebSocket i deklarują swoją **rolę**

## Transport

- WebSocket, ramki tekstowe z ładunkami JSON.
- Pierwsza ramka **musi** być żądaniem `connect`.

## Handshake (łączenie)

Gateway → Klient (wyzwanie przed połączeniem):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Klient → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → Klient:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

Gdy wydawany jest token urządzenia, `hello-ok` zawiera także:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Przykład węzła

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Ramkowanie

- **Żądanie**: `{type:"req", id, method, params}`
- **Odpowiedź**: `{type:"res", id, ok, payload|error}`
- **Zdarzenie**: `{type:"event", event, payload, seq?, stateVersion?}`

Metody wywołujące skutki uboczne wymagają **kluczy idempotencji** (zob. schemat).

## Role + zakresy

### Role + zakresy

- `operator` = klient płaszczyzny sterowania (CLI/UI/automatyzacja).
- `node` = host możliwości (kamera/ekran/płótno/system.run).

### Zakresy (operator)

Typowe zakresy:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Możliwości/polecenia/uprawnienia (węzeł)

Węzły deklarują roszczenia dotyczące możliwości w momencie łączenia:

- `caps`: wysokopoziomowe kategorie możliwości.
- `commands`: lista dozwolonych poleceń do wywołań.
- `permissions`: szczegółowe przełączniki (np. `screen.record`, `camera.capture`).

Gateway traktuje je jako **roszczenia** i egzekwuje listy dozwolonych po stronie serwera.

## Obecność

- `system-presence` zwraca wpisy kluczowane tożsamością urządzenia.
- Wpisy obecności zawierają `deviceId`, `roles` oraz `scopes`, aby interfejsy mogły wyświetlać jeden wiersz na urządzenie
  nawet gdy łączy się ono zarówno jako **operator**, jak i **węzeł**.

### Metody pomocnicze węzła

- Węzły mogą wywołać `skills.bins`, aby pobrać aktualną listę wykonywalnych Skills
  do automatycznych kontroli dozwolenia.

## Zatwierdzanie wykonania (exec approvals)

- Gdy żądanie exec wymaga zatwierdzenia, gateway rozgłasza `exec.approval.requested`.
- Klienci operatora rozstrzygają, wywołując `exec.approval.resolve` (wymaga zakresu `operator.approvals`).

## Wersjonowanie

- `PROTOCOL_VERSION` znajduje się w `src/gateway/protocol/schema.ts`.
- Klienci wysyłają `minProtocol` + `maxProtocol`; serwer odrzuca niezgodności.
- Schematy + modele są generowane z definicji TypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Uwierzytelnianie

- Jeśli ustawiono `OPENCLAW_GATEWAY_TOKEN` (lub `--token`), `connect.params.auth.token`
  musi się zgadzać, w przeciwnym razie gniazdo zostanie zamknięte.
- Po sparowaniu Gateway wydaje **token urządzenia** o zakresie zgodnym z rolą
  połączenia + zakresami. Jest on zwracany w `hello-ok.auth.deviceToken` i powinien być
  utrwalony przez klienta na potrzeby przyszłych połączeń.
- Tokeny urządzeń mogą być rotowane/cofane przez `device.token.rotate` oraz
  `device.token.revoke` (wymaga zakresu `operator.pairing`).

## Tożsamość urządzenia + parowanie

- Węzły powinny dołączać stabilną tożsamość urządzenia (`device.id`) wyprowadzoną z
  odcisku palca pary kluczy.
- Gateway wydają tokeny per urządzenie + rola.
- Zatwierdzenia parowania są wymagane dla nowych identyfikatorów urządzeń, chyba że włączono lokalne automatyczne zatwierdzanie.
- Połączenia **lokalne** obejmują loopback oraz własny adres tailnet hosta gateway
  (tak aby powiązania tailnet na tym samym hoście mogły nadal być automatycznie zatwierdzane).
- Wszyscy klienci WS muszą dołączać tożsamość `device` podczas `connect` (operator + węzeł).
  Interfejs sterowania może ją pominąć **wyłącznie** gdy włączono `gateway.controlUi.allowInsecureAuth`
  (lub `gateway.controlUi.dangerouslyDisableDeviceAuth` do użycia awaryjnego).
- Połączenia nielokalne muszą podpisać dostarczony przez serwer nonce `connect.challenge`.

## TLS + pinning

- TLS jest obsługiwany dla połączeń WS.
- Klienci mogą opcjonalnie przypiąć odcisk certyfikatu gateway (zob. konfigurację `gateway.tls`
  oraz `gateway.remote.tlsFingerprint` lub CLI `--tls-fingerprint`).

## Zakres

Ten protokół udostępnia **pełne API gateway** (status, kanały, modele, czat,
agent, sesje, węzły, zatwierdzenia itd.). Dokładny zakres jest zdefiniowany przez
schematy TypeBox w `src/gateway/protocol/schema.ts`.
