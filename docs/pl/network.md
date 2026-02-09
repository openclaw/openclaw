---
summary: "Hub sieciowy: powierzchnie gateway, parowanie, wykrywanie i bezpieczeństwo"
read_when:
  - Potrzebujesz przeglądu architektury sieci i bezpieczeństwa
  - Diagnozujesz dostęp lokalny vs. tailnet lub parowanie
  - Chcesz kanonicznej listy dokumentów sieciowych
title: "network.md"
---

# Hub sieciowy

Ten hub łączy kluczowe dokumenty opisujące, jak OpenClaw łączy się, paruje i
zabezpiecza urządzenia w obrębie localhost, LAN i tailnet.

## Model podstawowy

- [Architektura Gateway](/concepts/architecture)
- [Protokół Gateway](/gateway/protocol)
- [Runbook Gateway](/gateway)
- [Powierzchnie webowe + tryby wiązania](/web)

## Parowanie + tożsamość

- [Przegląd parowania (DM-y + węzły)](/channels/pairing)
- [Parowanie węzłów należących do Gateway](/gateway/pairing)
- [CLI urządzeń (parowanie + rotacja tokenów)](/cli/devices)
- [CLI parowania (zatwierdzanie DM-ów)](/cli/pairing)

Zaufanie lokalne:

- Połączenia lokalne (loopback lub własny adres tailnet hosta Gateway) mogą być
  automatycznie zatwierdzane do parowania, aby zachować płynne UX na tym samym hoście.
- Nielokalni klienci tailnet/LAN nadal wymagają jawnego zatwierdzenia parowania.

## Wykrywanie + transporty

- [Wykrywanie i transporty](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Dostęp zdalny (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Węzły + transporty

- [Przegląd węzłów](/nodes)
- [Protokół mostu (węzły legacy)](/gateway/bridge-protocol)
- [Runbook węzła: iOS](/platforms/ios)
- [Runbook węzła: Android](/platforms/android)

## Bezpieczeństwo

- [Przegląd bezpieczeństwa](/gateway/security)
- [Referencja konfiguracji Gateway](/gateway/configuration)
- [Rozwiązywanie problemów](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
