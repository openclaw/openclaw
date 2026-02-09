---
summary: "Przewodnik konfiguracji dla deweloperów pracujących nad aplikacją OpenClaw na macOS"
read_when:
  - Konfigurowanie środowiska deweloperskiego macOS
title: "Konfiguracja deweloperska macOS"
---

# Konfiguracja deweloperska macOS

Ten przewodnik opisuje niezbędne kroki, aby zbudować i uruchomić aplikację OpenClaw na macOS ze źródeł.

## Wymagania wstępne

Przed rozpoczęciem budowania aplikacji upewnij się, że masz zainstalowane:

1. **Xcode 26.2+**: Wymagany do tworzenia w Swift.
2. **Node.js 22+ i pnpm**: Wymagane dla Gateway, CLI oraz skryptów pakowania.

## 1) Instalacja zależności

Zainstaluj zależności dla całego projektu:

```bash
pnpm install
```

## 2. Budowanie i pakowanie aplikacji

Aby zbudować aplikację macOS i spakować ją do `dist/OpenClaw.app`, uruchom:

```bash
./scripts/package-mac-app.sh
```

Jeśli nie masz certyfikatu Apple Developer ID, skrypt automatycznie użyje **podpisywania ad-hoc** (`-`).

Informacje o trybach uruchamiania deweloperskiego, flagach podpisywania oraz rozwiązywaniu problemów z Team ID znajdziesz w README aplikacji macOS:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Uwaga**: Aplikacje podpisane ad-hoc mogą wywoływać monity bezpieczeństwa. Jeśli aplikacja natychmiast się zamyka z komunikatem „Abort trap 6”, zobacz sekcję [Rozwiązywanie problemów](#troubleshooting).

## 3. Instalacja CLI

Aplikacja macOS oczekuje globalnej instalacji CLI `openclaw` do zarządzania zadaniami w tle.

**Aby zainstalować (zalecane):**

1. Otwórz aplikację OpenClaw.
2. Przejdź do karty ustawień **General**.
3. Kliknij **„Install CLI”**.

Alternatywnie zainstaluj ręcznie:

```bash
npm install -g openclaw@<version>
```

## Rozwiązywanie problemów

### Błąd kompilacji: niezgodność toolchaina lub SDK

Budowanie aplikacji macOS wymaga najnowszego SDK macOS oraz toolchaina Swift 6.2.

**Zależności systemowe (wymagane):**

- **Najnowsza wersja macOS dostępna w Aktualizacji oprogramowania** (wymagana przez SDK Xcode 26.2)
- **Xcode 26.2** (toolchain Swift 6.2)

**Sprawdzenia:**

```bash
xcodebuild -version
xcrun swift --version
```

Jeśli wersje się nie zgadzają, zaktualizuj macOS/Xcode i ponownie uruchom budowanie.

### Aplikacja ulega awarii przy nadawaniu uprawnień

Jeśli aplikacja ulega awarii podczas próby zezwolenia na dostęp do **Rozpoznawania mowy** lub **Mikrofonu**, przyczyną może być uszkodzona pamięć podręczna TCC lub niezgodność podpisu.

**Naprawa:**

1. Zresetuj uprawnienia TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Jeśli to nie pomoże, tymczasowo zmień `BUNDLE_ID` w [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), aby wymusić „czystą kartę” po stronie macOS.

### Gateway „Starting...” bez końca

Jeśli status gateway (brama) pozostaje na „Starting...”, sprawdź, czy proces zombie nie blokuje portu:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Jeśli ręczne uruchomienie blokuje port, zatrzymaj ten proces (Ctrl+C). W ostateczności zakończ proces PID znaleziony powyżej.
