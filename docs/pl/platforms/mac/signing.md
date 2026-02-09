---
summary: "Kroki podpisywania dla debugowych buildów macOS generowanych przez skrypty pakujące"
read_when:
  - Budowanie lub podpisywanie debugowych buildów macOS
title: "Podpisywanie macOS"
---

# podpisywanie mac (debug buildy)

Ta aplikacja jest zwykle budowana z użyciem skryptu [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), który obecnie:

- ustawia stabilny identyfikator pakietu dla debugów: `ai.openclaw.mac.debug`
- zapisuje Info.plist z tym identyfikatorem pakietu (nadpisanie przez `BUNDLE_ID=...`)
- wywołuje [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh), aby podpisać główny plik binarny i pakiet aplikacji, tak aby macOS traktował każdą przebudowę jako ten sam podpisany pakiet i zachowywał uprawnienia TCC (powiadomienia, dostępność, nagrywanie ekranu, mikrofon, mowa). Dla stabilnych uprawnień użyj rzeczywistej tożsamości podpisu; podpis ad-hoc jest opcjonalny i kruchy (zob. [uprawnienia macOS](/platforms/mac/permissions)).
- domyślnie używa `CODESIGN_TIMESTAMP=auto`; włącza to zaufane znaczniki czasu dla podpisów Developer ID. Ustaw `CODESIGN_TIMESTAMP=off`, aby pominąć stemplowanie czasem (offline debug buildy).
- wstrzykuje metadane buildu do Info.plist: `OpenClawBuildTimestamp` (UTC) oraz `OpenClawGitCommit` (krótki hash), aby panel „About” mógł pokazywać informacje o buildzie, git oraz kanale debug/release.
- **Pakowanie wymaga Node 22+**: skrypt uruchamia buildy TS oraz build interfejsu Control UI.
- odczytuje `SIGN_IDENTITY` ze środowiska. Dodaj `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (lub swój certyfikat Developer ID Application) do rc swojej powłoki, aby zawsze podpisywać swoim certyfikatem. Podpis ad-hoc wymaga jawnego włączenia przez `ALLOW_ADHOC_SIGNING=1` lub `SIGN_IDENTITY="-"` (niezalecane do testowania uprawnień).
- po podpisaniu wykonuje audyt Team ID i kończy się niepowodzeniem, jeśli jakikolwiek Mach-O wewnątrz pakietu aplikacji jest podpisany innym Team ID. Ustaw `SKIP_TEAM_ID_CHECK=1`, aby pominąć.

## Użycie

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Uwaga dotycząca podpisywania ad-hoc

Podczas podpisywania za pomocą `SIGN_IDENTITY="-"` (ad-hoc) skrypt automatycznie wyłącza **Hardened Runtime** (`--options runtime`). Jest to konieczne, aby zapobiec awariom, gdy aplikacja próbuje załadować osadzone frameworki (takie jak Sparkle), które nie współdzielą tego samego Team ID. Podpisy ad-hoc również przerywają trwałość uprawnień TCC; zob. [uprawnienia macOS](/platforms/mac/permissions) w celu uzyskania kroków odzyskiwania.

## Metadane buildu dla „About”

`package-mac-app.sh` stempluje pakiet następującymi danymi:

- `OpenClawBuildTimestamp`: ISO8601 UTC w momencie pakowania
- `OpenClawGitCommit`: krótki hash gita (lub `unknown`, jeśli niedostępny)

Zakładka „About” odczytuje te klucze, aby wyświetlić wersję, datę buildu, commit gita oraz informację, czy jest to build debug (przez `#if DEBUG`). Uruchom pakowacz, aby odświeżyć te wartości po zmianach w kodzie.

## Dlaczego

Uprawnienia TCC są powiązane z identyfikatorem pakietu _oraz_ podpisem kodu. Niezabezpieczone debug buildy ze zmieniającymi się UUID powodowały, że macOS zapominał przyznane zgody po każdej przebudowie. Podpisywanie plików binarnych (domyślnie ad-hoc) i utrzymywanie stałego identyfikatora pakietu/ścieżki (`dist/OpenClaw.app`) zachowuje zgody pomiędzy buildami, zgodnie z podejściem VibeTunnel.
