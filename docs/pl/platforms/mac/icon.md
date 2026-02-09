---
summary: "Stany i animacje ikony paska menu dla OpenClaw na macOS"
read_when:
  - Zmienianie zachowania ikony paska menu
title: "Ikona paska menu"
---

# Stany ikony paska menu

Autor: steipete · Aktualizacja: 2025-12-06 · Zakres: aplikacja macOS (`apps/macos`)

- **Bezczynny:** Normalna animacja ikony (mruganie, okazjonalne poruszenie).
- **Wstrzymany:** Element statusu używa `appearsDisabled`; brak ruchu.
- **Wyzwalacz głosowy (duże uszy):** Detektor wybudzania głosem wywołuje `AppState.triggerVoiceEars(ttl: nil)` po usłyszeniu słowa wybudzającego, utrzymując `earBoostActive=true` podczas przechwytywania wypowiedzi. Uszy skalują się (1,9×), otrzymują okrągłe otwory dla lepszej czytelności, a następnie opadają przez `stopVoiceEars()` po 1 s ciszy. Uruchamiane wyłącznie z wewnątrzaplikacyjnego potoku głosowego.
- **Praca (agent uruchomiony):** `AppState.isWorking=true` steruje mikroruchem „szuranie ogona/nóg”: szybsze poruszanie nogami i niewielkie przesunięcie, gdy praca jest w toku. Obecnie przełączane wokół uruchomień agenta WebChat; dodaj to samo przełączanie wokół innych długich zadań po ich podłączeniu.

Punkty podłączenia

- Wybudzanie głosem: wywołaj `AppState.triggerVoiceEars(ttl: nil)` przy wyzwoleniu oraz `stopVoiceEars()` po 1 s ciszy, aby dopasować okno przechwytywania.
- Aktywność agenta: ustaw `AppStateStore.shared.setWorking(true/false)` wokół odcinków pracy (już zrobione w wywołaniu agenta WebChat). Utrzymuj krótkie odcinki i resetuj w blokach `defer`, aby uniknąć zablokowanych animacji.

Kształty i rozmiary

- Ikona bazowa rysowana w `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Skala uszu domyślnie wynosi `1.0`; wzmocnienie głosowe ustawia `earScale=1.9` i przełącza `earHoles=true` bez zmiany całkowitej ramki (szablon obrazu 18×18 pt renderowany do magazynu Retina 36×36 px).
- Scurry używa przełącznika nogi do ~1.0 z niewielkim gwiazdką poziomą; jest to dodatek do dowolnego istniejącego przełącznika bezczynności.

Uwagi dotyczące zachowania

- Brak zewnętrznego przełącznika CLI/brokera dla uszu/pracy; pozostaw to wewnętrznym sygnałom aplikacji, aby uniknąć przypadkowego „trzepotania”.
- Utrzymuj krótkie TTL (&lt;10 s), aby ikona szybko wracała do stanu bazowego, jeśli zadanie się zawiesi.
