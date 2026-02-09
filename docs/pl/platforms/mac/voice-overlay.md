---
summary: "„Cykl życia nakładki głosowej, gdy nakładają się słowo wybudzające i tryb push‑to‑talk”"
read_when:
  - Dostosowywanie zachowania nakładki głosowej
title: "„Nakładka głosowa”"
---

# Cykl życia nakładki głosowej (macOS)

Odbiorcy: współtwórcy aplikacji na macOS. Cel: utrzymać przewidywalne zachowanie nakładki głosowej, gdy nakładają się słowo wybudzające i push‑to‑talk.

## Aktualna intencja

- Jeśli nakładka jest już widoczna z powodu słowa wybudzającego, a użytkownik naciśnie skrót klawiszowy, sesja hotkey _przejmuje_ istniejący tekst zamiast go resetować. Nakładka pozostaje widoczna, dopóki skrót jest przytrzymany. Po zwolnieniu: wyślij, jeśli istnieje przycięty tekst; w przeciwnym razie zamknij.
- Samo słowo wybudzające nadal wysyła automatycznie po ciszy; push‑to‑talk wysyła natychmiast po zwolnieniu.

## Zaimplementowane (9 grudnia 2025)

- Sesje nakładki przenoszą teraz token na każde przechwycenie (słowo wybudzające lub push‑to‑talk). Aktualizacje częściowe/końcowe/wysyłania/zamykania/poziomu są odrzucane, gdy token się nie zgadza, co zapobiega przestarzałym wywołaniom zwrotnym.
- Push‑to‑talk przejmuje dowolny widoczny tekst nakładki jako prefiks (tak aby naciśnięcie skrótu, gdy nakładka wybudzenia jest aktywna, zachowało tekst i dodało nową mowę). Czeka do 1,5 s na końcową transkrypcję, po czym w razie potrzeby wraca do bieżącego tekstu.
- Logowanie dźwięków sygnalnych/nakładki jest emitowane w `info` w kategoriach `voicewake.overlay`, `voicewake.ptt` oraz `voicewake.chime` (start sesji, częściowe, końcowe, wysłanie, zamknięcie, powód dźwięku).

## Następne kroki

1. **VoiceSessionCoordinator (actor)**
   - W danym momencie posiada dokładnie jeden `VoiceSession`.
   - API (oparte na tokenach): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Odrzuca wywołania zwrotne niosące przestarzałe tokeny (zapobiega ponownemu otwieraniu nakładki przez stare rozpoznawacze).
2. **VoiceSession (model)**
   - Pola: `token`, `source` (wakeWord|pushToTalk), tekst zatwierdzony/ulotny, flagi dźwięków, timery (auto‑wysyłanie, bezczynność), `overlayMode` (display|editing|sending), termin zakończenia cooldown.
3. **Powiązanie nakładki**
   - `VoiceSessionPublisher` (`ObservableObject`) odzwierciedla aktywną sesję w SwiftUI.
   - `VoiceWakeOverlayView` renderuje wyłącznie poprzez publisher; nigdy nie modyfikuje bezpośrednio globalnych singletonów.
   - Akcje użytkownika w nakładce (`sendNow`, `dismiss`, `edit`) wywołują koordynatora z tokenem sesji.
4. **Ujednolicona ścieżka wysyłania**
   - Przy `endCapture`: jeśli przycięty tekst jest pusty → zamknij; w przeciwnym razie `performSend(session:)` (odtwarza dźwięk wysyłania jeden raz, przekazuje dalej, zamyka).
   - Push‑to‑talk: bez opóźnienia; słowo wybudzające: opcjonalne opóźnienie dla auto‑wysyłania.
   - Zastosuj krótki cooldown dla środowiska wake po zakończeniu push‑to‑talk, aby słowo wybudzające nie uruchamiało się natychmiast ponownie.
5. **Logowanie**
   - Koordynator emituje logi `.info` w podsystemie `bot.molt`, kategorie `voicewake.overlay` oraz `voicewake.chime`.
   - Kluczowe zdarzenia: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Lista kontrolna debugowania

- Strumieniuj logi podczas odtwarzania „przyklejonej” nakładki:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Zweryfikuj, że istnieje tylko jeden aktywny token sesji; przestarzałe wywołania zwrotne powinny być odrzucane przez koordynatora.

- Upewnij się, że zwolnienie push‑to‑talk zawsze wywołuje `endCapture` z aktywnym tokenem; jeśli tekst jest pusty, oczekuj `dismiss` bez dźwięku i bez wysyłania.

## Kroki migracji (sugerowane)

1. Dodaj `VoiceSessionCoordinator`, `VoiceSession` oraz `VoiceSessionPublisher`.
2. Zrefaktoryzuj `VoiceWakeRuntime`, aby tworzyć/aktualizować/kończyć sesje zamiast bezpośrednio dotykać `VoiceWakeOverlayController`.
3. Zrefaktoryzuj `VoicePushToTalk`, aby przejmować istniejące sesje i wywoływać `endCapture` przy zwolnieniu; zastosuj cooldown środowiska.
4. Podłącz `VoiceWakeOverlayController` do publishera; usuń bezpośrednie wywołania z runtime/PTT.
5. Dodaj testy integracyjne dla przejmowania sesji, cooldown oraz zamykania przy pustym tekście.
