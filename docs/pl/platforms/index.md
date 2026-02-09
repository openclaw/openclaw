---
summary: "„Przegląd obsługi platform (Gateway + aplikacje towarzyszące)”"
read_when:
  - Szukasz informacji o obsłudze systemów operacyjnych lub ścieżkach instalacji
  - Decydujesz, gdzie uruchomić Gateway
title: "„Platformy”"
---

# Platformy

Rdzeń OpenClaw jest napisany w TypeScript. **Node jest zalecanym środowiskiem uruchomieniowym**.
Bun nie jest zalecany dla Gateway (błędy WhatsApp/Telegram).

Aplikacje towarzyszące są dostępne dla macOS (aplikacja w pasku menu) oraz węzłów mobilnych (iOS/Android). Aplikacje towarzyszące dla Windows i
Linux są planowane, jednak Gateway jest dziś w pełni obsługiwany.
Planowane są również natywne aplikacje towarzyszące dla Windows; zalecane jest uruchamianie Gateway przez WSL2.

## Wybierz swój system operacyjny

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS i hosting

- Hub VPS: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + proxy HTTPS): [exe.dev](/install/exe-dev)

## Typowe linki

- Przewodnik instalacji: [Pierwsze kroki](/start/getting-started)
- Runbook Gateway: [Gateway](/gateway)
- Konfiguracja Gateway: [Konfiguracja](/gateway/configuration)
- Status usługi: `openclaw gateway status`

## Instalacja usługi Gateway (CLI)

Użyj jednej z poniższych opcji (wszystkie są obsługiwane):

- Kreator (zalecane): `openclaw onboard --install-daemon`
- Bezpośrednio: `openclaw gateway install`
- Przepływ konfiguracji: `openclaw configure` → wybierz **usługę Gateway**
- Naprawa/migracja: `openclaw doctor` (oferuje instalację lub naprawę usługi)

Cel usługi zależy od systemu operacyjnego:

- macOS: LaunchAgent (`bot.molt.gateway` lub `bot.molt.<profile>`; starsze `com.openclaw.*`)
- Linux/WSL2: usługa użytkownika systemd (`openclaw-gateway[-<profile>].service`)
