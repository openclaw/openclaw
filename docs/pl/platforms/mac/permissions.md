---
summary: "Trwałość uprawnień macOS (TCC) oraz wymagania dotyczące podpisywania"
read_when:
  - Debugowanie brakujących lub zablokowanych monitów uprawnień macOS
  - Pakietowanie lub podpisywanie aplikacji macOS
  - Zmiana identyfikatorów pakietu lub ścieżek instalacji aplikacji
title: "Uprawnienia macOS"
---

# Uprawnienia macOS (TCC)

Przyznawanie uprawnień w macOS jest wrażliwe. TCC wiąże przyznane uprawnienie z
podpisem kodu aplikacji, identyfikatorem pakietu oraz ścieżką na dysku. Jeśli którykolwiek
z tych elementów się zmieni, macOS traktuje aplikację jak nową i może usunąć lub ukryć monity.

## Wymagania dla stabilnych uprawnień

- Ta sama ścieżka: uruchamiaj aplikację z niezmiennej lokalizacji (dla OpenClaw, `dist/OpenClaw.app`).
- Ten sam identyfikator pakietu: zmiana bundle ID tworzy nową tożsamość uprawnień.
- Podpisana aplikacja: kompilacje niepodpisane lub podpisane ad-hoc nie zachowują uprawnień.
- Spójny podpis: używaj prawdziwego certyfikatu Apple Development lub Developer ID,
  aby podpis pozostawał stabilny między przebudowaniami.

Podpisy ad-hoc generują nową tożsamość przy każdej kompilacji. macOS zapomni wcześniejsze
przyznania, a monity mogą całkowicie zniknąć, dopóki nie zostaną wyczyszczone przestarzałe wpisy.

## Lista kontrolna odzyskiwania, gdy monity znikają

1. Zamknij aplikację.
2. Usuń wpis aplikacji w Ustawienia systemowe -> Prywatność i bezpieczeństwo.
3. Uruchom ponownie aplikację z tej samej ścieżki i ponownie przyznaj uprawnienia.
4. Jeśli monit nadal się nie pojawia, zresetuj wpisy TCC za pomocą `tccutil` i spróbuj ponownie.
5. Niektóre uprawnienia pojawiają się ponownie dopiero po pełnym restarcie macOS.

Przykładowe resetowania (w razie potrzeby podmień identyfikator pakietu):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Uprawnienia do plików i folderów (Pulpit/Dokumenty/Pobrane)

macOS może również ograniczać dostęp do Pulpitu, Dokumentów i Pobranych dla procesów terminalowych lub działających w tle. Jeśli odczyty plików lub listowania katalogów zawieszają się, przyznaj dostęp temu samemu kontekstowi procesu, który wykonuje operacje na plikach (na przykład Terminal/iTerm, aplikacja uruchamiana przez LaunchAgent lub proces SSH).

Obejście: przenieś pliki do obszaru roboczego OpenClaw (`~/.openclaw/workspace`), jeśli chcesz uniknąć przyznawania uprawnień per folder.

Jeśli testujesz uprawnienia, zawsze podpisuj aplikację prawdziwym certyfikatem. Kompilacje
ad-hoc są akceptowalne wyłącznie do szybkich lokalnych uruchomień, w których uprawnienia nie mają znaczenia.
