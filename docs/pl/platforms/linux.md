---
summary: "Wsparcie dla Linuksa + status aplikacji towarzyszącej"
read_when:
  - Szukasz informacji o statusie aplikacji towarzyszącej na Linuksa
  - Planujesz zakres wsparcia platform lub wkład w rozwój
title: "Aplikacja Linux"
---

# Aplikacja Linux

Gateway jest w pełni wspierany na Linuksie. **Node jest zalecanym środowiskiem uruchomieniowym**.
Bun nie jest zalecany dla Gateway (błędy WhatsApp/Telegram).

Natywne aplikacje towarzyszące dla Linuksa są planowane. Wkład w rozwój jest mile widziany, jeśli chcesz pomóc w stworzeniu takiej aplikacji.

## Szybka ścieżka dla początkujących (VPS)

1. Zainstaluj Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Z laptopa: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Otwórz `http://127.0.0.1:18789/` i wklej swój token

Przewodnik VPS krok po kroku: [exe.dev](/install/exe-dev)

## Instalacja

- [Pierwsze kroki](/start/getting-started)
- [Instalacja i aktualizacje](/install/updating)
- Opcjonalne ścieżki: [Bun (eksperymentalnie)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Runbook Gateway](/gateway)
- [Konfiguracja](/gateway/configuration)

## Instalacja usługi Gateway (CLI)

Użyj jednej z opcji:

```
openclaw onboard --install-daemon
```

Lub:

```
openclaw gateway install
```

Lub:

```
openclaw configure
```

Po wyświetleniu monitu wybierz **usługę Gateway**.

Naprawa/migracja:

```
openclaw doctor
```

## Kontrola systemowa (jednostka użytkownika systemd)

OpenClaw domyślnie instaluje usługę systemd **użytkownika**. Użyj usługi
**systemowej** dla serwerów współdzielonych lub zawsze włączonych. Pełny przykład jednostki oraz wskazówki znajdują się w [runbooku Gateway](/gateway).

Minimalna konfiguracja:

Utwórz `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Włącz ją:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
