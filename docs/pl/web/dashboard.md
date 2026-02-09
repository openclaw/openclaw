---
summary: "Dostęp i uwierzytelnianie pulpitu Gateway (Control UI)"
read_when:
  - Zmieniasz tryby uwierzytelniania lub ekspozycji pulpitu
title: "Panel"
---

# Pulpit (Control UI)

Pulpit Gateway to przeglądarkowy Control UI serwowany domyślnie pod adresem `/`
(nadpisz za pomocą `gateway.controlUi.basePath`).

Szybkie otwarcie (lokalny Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (lub [http://localhost:18789/](http://localhost:18789/))

Kluczowe odnośniki:

- [Control UI](/web/control-ui) — użycie i możliwości interfejsu.
- [Tailscale](/gateway/tailscale) — automatyzacja Serve/Funnel.
- [Web surfaces](/web) — tryby wiązania i uwagi dotyczące bezpieczeństwa.

Uwierzytelnianie jest wymuszane podczas handshake WebSocket za pomocą `connect.params.auth`
(token lub hasło). Zobacz `gateway.auth` w [konfiguracji Gateway](/gateway/configuration).

Uwaga dotycząca bezpieczeństwa: Control UI jest **powierzchnią administracyjną** (czat, konfiguracja, zatwierdzanie exec).
Nie wystawiaj go publicznie. Interfejs zapisuje token w `localStorage` po pierwszym załadowaniu.
Preferuj localhost, Tailscale Serve lub tunel SSH.

## Szybka ścieżka (zalecane)

- Po onboardingu CLI automatycznie otwiera pulpit i wypisuje czysty (bez tokenu) link.
- Otwórz ponownie w dowolnym momencie: `openclaw dashboard` (kopiuje link, otwiera przeglądarkę, jeśli to możliwe, pokazuje wskazówkę SSH w trybie headless).
- Jeśli UI poprosi o uwierzytelnienie, wklej token z `gateway.auth.token` (lub `OPENCLAW_GATEWAY_TOKEN`) w ustawieniach Control UI.

## Podstawy tokenu (lokalny vs remote)

- **Localhost**: otwórz `http://127.0.0.1:18789/`.
- **Źródło tokenu**: `gateway.auth.token` (lub `OPENCLAW_GATEWAY_TOKEN`); UI zapisuje kopię w localStorage po połączeniu.
- **Poza localhost**: użyj Tailscale Serve (bez tokenu, jeśli `gateway.auth.allowTailscale: true`), wiązania tailnet z tokenem lub tunelu SSH. Zobacz [Web surfaces](/web).

## Jeśli widzisz „unauthorized” / 1008

- Upewnij się, że gateway jest osiągalny (lokalnie: `openclaw status`; zdalnie: tunel SSH `ssh -N -L 18789:127.0.0.1:18789 user@host`, następnie otwórz `http://127.0.0.1:18789/`).
- Pobierz token z hosta Gateway: `openclaw config get gateway.auth.token` (lub wygeneruj nowy: `openclaw doctor --generate-gateway-token`).
- W ustawieniach pulpitu wklej token w pole uwierzytelniania, a następnie połącz się.
