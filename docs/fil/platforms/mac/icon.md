---
summary: "Mga estado at animasyon ng icon sa menu bar para sa OpenClaw sa macOS"
read_when:
  - Pagbabago ng gawi ng icon sa menu bar
title: "Icon sa Menu Bar"
---

# Mga Estado ng Icon sa Menu Bar

May-akda: steipete · In-update: 2025-12-06 · Saklaw: macOS app (`apps/macos`)

- **Idle:** Karaniwang animasyon ng icon (pagkurap, paminsan-minsang wiggle).
- **Paused:** Gumagamit ang status item ng `appearsDisabled`; walang galaw.
- **Voice trigger (big ears):** Tinatawag ng voice wake detector ang `AppState.triggerVoiceEars(ttl: nil)` kapag narinig ang wake word, pinananatiling `earBoostActive=true` habang kinukuha ang utterance. Lumalaki ang mga tainga (1.9x), nagkakaroon ng mga bilog na butas sa tainga para sa readability, pagkatapos ay bumababa sa pamamagitan ng `stopVoiceEars()` matapos ang 1s ng katahimikan. Pinapaputok lamang mula sa in-app voice pipeline.
- **Working (agent running):** Ang `AppState.isWorking=true` ang nagtutulak ng isang “tail/leg scurry” na micro-motion: mas mabilis na wiggle ng mga paa at bahagyang offset habang may ginagawang trabaho. Kasalukuyang tine-toggle sa paligid ng mga run ng WebChat agent; idagdag ang parehong toggle sa paligid ng iba pang mahahabang gawain kapag ikinabit mo ang mga iyon.

Mga wiring point

- Voice wake: tumawag ang runtime/tester ng `AppState.triggerVoiceEars(ttl: nil)` sa trigger at `stopVoiceEars()` matapos ang 1s ng katahimikan para tumugma sa capture window.
- Aktibidad ng agent: itakda ang `AppStateStore.shared.setWorking(true/false)` sa paligid ng mga span ng trabaho (nagawa na sa tawag ng WebChat agent). Panatilihing maikli ang mga span at mag-reset sa mga `defer` block upang maiwasan ang na-stuck na mga animation.

Mga hugis at sukat

- Ang base icon ay iginuhit sa `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Ang default na ear scale ay `1.0`; itinatakda ng voice boost ang `earScale=1.9` at tina-toggle ang `earHoles=true` nang hindi binabago ang kabuuang frame (18×18 pt na template image na nirender sa 36×36 px na Retina backing store).
- Gumagamit ang scurry ng leg wiggle hanggang ~1.0 na may maliit na pahalang na jiggle; additive ito sa anumang umiiral na idle wiggle.

Mga tala sa gawi

- Walang external na CLI/broker toggle para sa ears/working; panatilihin itong internal sa sariling mga signal ng app upang maiwasan ang aksidenteng flapping.
- Panatilihing maikli ang mga TTL (&lt;10s) upang mabilis na bumalik sa baseline ang icon kung may job na mag-hang.
