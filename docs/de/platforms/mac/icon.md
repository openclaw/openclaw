---
summary: "„Status der Menüleisten‑Symbole und Animationen für OpenClaw unter macOS“"
read_when:
  - Ändern des Verhaltens des Menüleisten‑Symbols
title: "„Menüleisten‑Symbol“"
---

# Zustände des Menüleisten‑Symbols

Autor: steipete · Aktualisiert: 2025-12-06 · Geltungsbereich: macOS‑App (`apps/macos`)

- **Leerlauf:** Normale Symbolanimation (Blinzeln, gelegentliches Wackeln).
- **Pausiert:** Status‑Item verwendet `appearsDisabled`; keine Bewegung.
- **Sprachauslöser (große Ohren):** Der Sprach‑Wake‑Detektor ruft `AppState.triggerVoiceEars(ttl: nil)` auf, wenn das Aktivierungswort erkannt wird, und hält `earBoostActive=true` während der Erfassung der Äußerung. Die Ohren skalieren nach oben (1,9×), erhalten zur besseren Lesbarkeit runde Ohröffnungen und fallen dann über `stopVoiceEars()` nach 1 s Stille wieder ab. Wird ausschließlich aus der In‑App‑Sprachpipeline ausgelöst.
- **Arbeitend (Agent läuft):** `AppState.isWorking=true` steuert eine Mikro‑Bewegung „Schwanz/Bein‑Huschen“: schnelleres Beinwackeln und leichte Versetzung, während Arbeit läuft. Derzeit um WebChat‑Agent‑Läufe herum umgeschaltet; fügen Sie dieselbe Umschaltung auch um andere lange Aufgaben hinzu, wenn Sie diese anbinden.

Verdrahtungspunkte

- Sprach‑Wake: Runtime/Tester ruft `AppState.triggerVoiceEars(ttl: nil)` beim Auslösen und `stopVoiceEars()` nach 1 s Stille auf, um dem Erfassungsfenster zu entsprechen.
- Agent‑Aktivität: Setzen Sie `AppStateStore.shared.setWorking(true/false)` um Arbeitsspannen (bereits im WebChat‑Agent‑Aufruf umgesetzt). Halten Sie Spannen kurz und setzen Sie in `defer`‑Blöcken zurück, um festhängende Animationen zu vermeiden.

Formen & Größen

- Basissymbol gezeichnet in `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Ohr‑Skalierung standardmäßig `1.0`; Sprach‑Boost setzt `earScale=1.9` und schaltet `earHoles=true` um, ohne den Gesamtrahmen zu ändern (18×18 pt‑Vorlagenbild, gerendert in einen 36×36 px‑Retina‑Backing‑Store).
- Das Huschen verwendet ein Beinwackeln bis ~1,0 mit einer kleinen horizontalen Bewegung; es addiert sich zu jedem bestehenden Leerlauf‑Wackeln.

Verhaltenshinweise

- Kein externer CLI/Broker‑Schalter für Ohren/Arbeiten; halten Sie dies intern an die eigenen App‑Signale gebunden, um unbeabsichtigtes Flattern zu vermeiden.
- Halten Sie TTLs kurz (&lt;10 s), damit das Symbol schnell zur Basislinie zurückkehrt, falls ein Auftrag hängt.
