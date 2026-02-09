---
summary: "Dokumentacja referencyjna CLI dla `openclaw node` (bezgłowy host węzła)"
read_when:
  - Uruchamianie bezgłowego hosta węzła
  - Parowanie węzła spoza macOS dla system.run
title: "node"
---

# `openclaw node`

Uruchamia **bezgłowy host węzła**, który łączy się z WebSocketem Gateway i udostępnia
`system.run` / `system.which` na tej maszynie.

## Dlaczego warto używać hosta węzła?

Użyj hosta węzła, gdy chcesz, aby agenci **uruchamiali polecenia na innych maszynach**
w Twojej sieci bez instalowania pełnej aplikacji towarzyszącej na macOS.

Typowe przypadki użycia:

- Uruchamianie poleceń na zdalnych maszynach Linux/Windows (serwery buildów, maszyny laboratoryjne, NAS).
- Zachowanie wykonania **sandboxed** na gateway, przy jednoczesnym delegowaniu zatwierdzonych uruchomień do innych hostów.
- Zapewnienie lekkiego, bezgłowego celu wykonawczego dla automatyzacji lub węzłów CI.

Wykonanie jest nadal chronione przez **zatwierdzanie wykonania (exec approvals)** oraz listy dozwolonych na poziomie agenta na hoście węzła, dzięki czemu dostęp do poleceń pozostaje ograniczony i jawny.

## Proxy przeglądarki (zero-config)

Hosty węzłów automatycznie ogłaszają proxy przeglądarki, jeśli `browser.enabled` nie jest
wyłączone na węźle. Pozwala to agentowi korzystać z automatyzacji przeglądarki na tym węźle
bez dodatkowej konfiguracji.

W razie potrzeby wyłącz to na węźle:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Uruchomienie (pierwszy plan)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Opcje:

- `--host <host>`: host WebSocket Gateway (domyślnie: `127.0.0.1`)
- `--port <port>`: port WebSocket Gateway (domyślnie: `18789`)
- `--tls`: użyj TLS dla połączenia z gateway
- `--tls-fingerprint <sha256>`: oczekiwany odcisk certyfikatu TLS (sha256)
- `--node-id <id>`: nadpisz identyfikator węzła (czyści token parowania)
- `--display-name <name>`: nadpisz nazwę wyświetlaną węzła

## Usługa (tło)

Zainstaluj bezgłowy host węzła jako usługę użytkownika.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Opcje:

- `--host <host>`: host WebSocket Gateway (domyślnie: `127.0.0.1`)
- `--port <port>`: port WebSocket Gateway (domyślnie: `18789`)
- `--tls`: użyj TLS dla połączenia z gateway
- `--tls-fingerprint <sha256>`: oczekiwany odcisk certyfikatu TLS (sha256)
- `--node-id <id>`: nadpisz identyfikator węzła (czyści token parowania)
- `--display-name <name>`: nadpisz nazwę wyświetlaną węzła
- `--runtime <runtime>`: środowisko uruchomieniowe usługi (`node` lub `bun`)
- `--force`: ponowna instalacja/nadpisanie, jeśli już zainstalowana

Zarządzanie usługą:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Użyj `openclaw node run` dla hosta węzła działającego na pierwszym planie (bez usługi).

Polecenia usługi akceptują `--json` dla wyjścia czytelnego maszynowo.

## Parowanie

Pierwsze połączenie tworzy oczekujące żądanie parowania węzła w Gateway.
Zatwierdź je przez:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Host węzła przechowuje swój identyfikator węzła, token, nazwę wyświetlaną oraz informacje o połączeniu z gateway w
`~/.openclaw/node.json`.

## Zatwierdzanie wykonania (exec approvals)

`system.run` jest objęte lokalnym zatwierdzaniem wykonania:

- `~/.openclaw/exec-approvals.json`
- [Zatwierdzanie wykonania](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (edytowane z Gateway)
