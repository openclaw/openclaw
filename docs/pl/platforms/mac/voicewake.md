---
summary: "Tryby wybudzania głosem i push‑to‑talk oraz szczegóły routingu w aplikacji na macOS"
read_when:
  - Praca nad ścieżkami wybudzania głosem lub PTT
title: "Wybudzanie głosem"
---

# Wybudzanie głosem i Push‑to‑Talk

## Mody

- **Tryb wybudzania słowem kluczowym** (domyślny): zawsze włączony rozpoznawacz mowy czeka na tokeny wyzwalające (`swabbleTriggerWords`). Po dopasowaniu rozpoczyna przechwytywanie, wyświetla nakładkę z tekstem częściowym i automatycznie wysyła po wykryciu ciszy.
- **Push‑to‑talk (przytrzymanie prawego Option)**: przytrzymaj prawy klawisz Option, aby rozpocząć przechwytywanie natychmiast — bez wyzwalacza. Nakładka jest widoczna podczas przytrzymania; zwolnienie finalizuje i przekazuje po krótkim opóźnieniu, aby umożliwić korektę tekstu.

## Zachowanie w czasie działania (wybudzanie słowem kluczowym)

- Rozpoznawacz mowy działa w `VoiceWakeRuntime`.
- Wyzwalacz uruchamia się tylko wtedy, gdy występuje **znacząca pauza** między słowem wybudzającym a następnym słowem (~0,55 s). Nakładka/dźwięk może uruchomić się na pauzie jeszcze przed rozpoczęciem polecenia.
- Okna ciszy: 2,0 s, gdy mowa płynie; 5,0 s, jeśli usłyszano tylko wyzwalacz.
- Twarde zatrzymanie: 120 s, aby zapobiec niekontrolowanym sesjom.
- Debounce między sesjami: 350 ms.
- Nakładka jest sterowana przez `VoiceWakeOverlayController` z kolorowaniem zatwierdzonym/ulotnym.
- Po wysłaniu rozpoznawacz restartuje się w czysty sposób, aby nasłuchiwać kolejnego wyzwalacza.

## Niezmienniki cyklu życia

- Jeśli Wybudzanie głosem jest włączone i przyznano uprawnienia, rozpoznawacz słowa kluczowego powinien nasłuchiwać (z wyjątkiem jawnego przechwytywania push‑to‑talk).
- Widoczność nakładki (w tym ręczne zamknięcie przyciskiem X) nigdy nie może uniemożliwiać wznowienia rozpoznawacza.

## Tryb awarii „przyklejonej” nakładki (wcześniej)

Wcześniej, jeśli nakładka utknęła jako widoczna i zamknięto ją ręcznie, Wybudzanie głosem mogło wyglądać na „martwe”, ponieważ próba restartu w czasie działania mogła być blokowana przez widoczność nakładki i nie planowano kolejnego restartu.

Wzmocnienia:

- Restart środowiska wybudzania nie jest już blokowany przez widoczność nakładki.
- Zakończenie zamknięcia nakładki wyzwala `VoiceWakeRuntime.refresh(...)` przez `VoiceSessionCoordinator`, dzięki czemu ręczne zamknięcie X zawsze wznawia nasłuch.

## Szczegóły push‑to‑talk

- Wykrywanie skrótu używa globalnego monitora `.flagsChanged` dla **prawego Option** (`keyCode 61` + `.option`). Tylko obserwujemy zdarzenia (bez ich przechwytywania).
- Potok przechwytywania działa w `VoicePushToTalk`: natychmiast uruchamia rozpoznawanie mowy, strumieniuje częściowe wyniki do nakładki i wywołuje `VoiceWakeForwarder` po zwolnieniu.
- Po rozpoczęciu push‑to‑talk wstrzymujemy środowisko wybudzania słowem kluczowym, aby uniknąć rywalizujących „podsłuchów” audio; po zwolnieniu uruchamia się ono ponownie automatycznie.
- Uprawnienia: wymagane są Mikrofon + Mowa; do podglądu zdarzeń potrzebna jest zgoda Dostępność/Monitorowanie wejścia.
- Klawiatury zewnętrzne: niektóre mogą nie udostępniać prawego Option zgodnie z oczekiwaniami — w razie zgłoszeń braków należy zaproponować skrót zapasowy.

## Ustawienia widoczne dla użytkownika

- Przełącznik **Wybudzanie głosem**: włącza środowisko wybudzania słowem kluczowym.
- **Przytrzymaj Cmd+Fn, aby mówić**: włącza monitor push‑to‑talk. Wyłączone na macOS < 26.
- Wybór języka i mikrofonu, miernik poziomu na żywo, tabela słów wyzwalających, tester (tylko lokalnie; nie przekazuje).
- Wybór mikrofonu zachowuje ostatnią selekcję po odłączeniu urządzenia, pokazuje wskazówkę o rozłączeniu i tymczasowo przełącza na domyślny systemowy do czasu powrotu.
- **Dźwięki**: sygnały przy wykryciu wyzwalacza i przy wysyłaniu; domyślnie systemowy dźwięk macOS „Glass”. Dla każdego zdarzenia można wybrać dowolny plik ładowalny przez `NSSound` (np. MP3/WAV/AIFF) lub wybrać **Brak dźwięku**.

## Zachowanie przekazywania

- Gdy Wybudzanie głosem jest włączone, transkrypcje są przekazywane do aktywnego gateway/agent (ten sam tryb lokalny vs zdalny, którego używa reszta aplikacji na macOS).
- Odpowiedzi są dostarczane do **ostatnio używanego głównego dostawcy** (WhatsApp/Telegram/Discord/WebChat). Jeśli dostarczenie się nie powiedzie, błąd jest rejestrowany, a uruchomienie pozostaje widoczne w logach WebChat/sesji.

## Ładunek przekazywania

- `VoiceWakeForwarder.prefixedTranscript(_:)` dodaje na początku wskazówkę o maszynie przed wysłaniem. Wspólne dla ścieżek wybudzania słowem kluczowym i push‑to‑talk.

## Szybka weryfikacja

- Włącz push‑to‑talk, przytrzymaj Cmd+Fn, mów, zwolnij: nakładka powinna pokazać częściowe wyniki, a następnie wysłać.
- Podczas przytrzymania uszy na pasku menu powinny pozostać powiększone (używa `triggerVoiceEars(ttl:nil)`); po zwolnieniu opadają.
