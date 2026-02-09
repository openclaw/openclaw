---
summary: "Wtyczka Zalo Personal: logowanie QR + wiadomości przez zca-cli (instalacja wtyczki + konfiguracja kanału + CLI + narzędzie)"
read_when:
  - Chcesz nieoficjalne wsparcie Zalo Personal w OpenClaw
  - Konfigurujesz lub rozwijasz wtyczkę zalouser
title: "Wtyczka Zalo Personal"
---

# Zalo Personal (wtyczka)

Wsparcie Zalo Personal dla OpenClaw poprzez wtyczkę, wykorzystujące `zca-cli` do automatyzacji zwykłego konta użytkownika Zalo.

> **Ostrzeżenie:** Nieoficjalna automatyzacja może prowadzić do zawieszenia lub zablokowania konta. Używasz na własne ryzyko.

## Nazewnictwo

Identyfikator kanału to `zalouser`, aby jednoznacznie wskazać, że automatyzuje **osobiste konto użytkownika Zalo** (nieoficjalnie). `zalo` zachowujemy na potrzeby ewentualnej przyszłej oficjalnej integracji z API Zalo.

## Gdzie działa

Ta wtyczka działa **wewnątrz procesu Gateway**.

Jeśli używasz zdalnego Gateway, zainstaluj i skonfiguruj ją na **maszynie uruchamiającej Gateway**, a następnie zrestartuj Gateway.

## Instalacja

### Opcja A: instalacja z npm

```bash
openclaw plugins install @openclaw/zalouser
```

Po zakończeniu zrestartuj Gateway.

### Opcja B: instalacja z lokalnego folderu (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Po zakończeniu zrestartuj Gateway.

## Wymaganie wstępne: zca-cli

Maszyna Gateway musi mieć `zca` na `PATH`:

```bash
zca --version
```

## Konfiguracja

Konfiguracja kanału znajduje się w `channels.zalouser` (nie w `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Narzędzie agenta

Nazwa narzędzia: `zalouser`

Akcje: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
