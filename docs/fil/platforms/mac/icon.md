---
summary: "Mga estado at animasyon ng icon sa menu bar para sa OpenClaw sa macOS"
read_when:
  - Pagbabago ng gawi ng icon sa menu bar
title: "Icon sa Menu Bar"
x-i18n:
  source_path: platforms/mac/icon.md
  source_hash: a67a6e6bbdc2b611
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:40Z
---

# Mga Estado ng Icon sa Menu Bar

May-akda: steipete · In-update: 2025-12-06 · Saklaw: macOS app (`apps/macos`)

- **Idle:** Karaniwang animasyon ng icon (pagkurap, paminsan-minsang wiggle).
- **Paused:** Gumagamit ang status item ng `appearsDisabled`; walang galaw.
- **Voice trigger (malalaking tainga):** Tinatawag ng voice wake detector ang `AppState.triggerVoiceEars(ttl: nil)` kapag narinig ang wake word, pinananatili ang `earBoostActive=true` habang kinukuha ang utterance. Lumalaki ang tainga (1.9x), nagkakaroon ng bilog na ear holes para sa mas malinaw na readability, pagkatapos ay bumabagsak sa pamamagitan ng `stopVoiceEars()` matapos ang 1s ng katahimikan. Tanging pinapaputok mula sa in-app voice pipeline.
- **Working (tumatakbong agent):** Pinapagana ng `AppState.isWorking=true` ang “tail/leg scurry” na micro-motion: mas mabilis na leg wiggle at bahagyang offset habang may isinasagawang trabaho. Kasalukuyang tina-toggle sa paligid ng mga run ng WebChat agent; idagdag ang parehong toggle sa iba pang mahahabang gawain kapag ikinabit mo na ang mga ito.

Mga wiring point

- Voice wake: tumawag ang runtime/tester ng `AppState.triggerVoiceEars(ttl: nil)` sa trigger at `stopVoiceEars()` matapos ang 1s ng katahimikan para tumugma sa capture window.
- Aktibidad ng agent: itakda ang `AppStateStore.shared.setWorking(true/false)` sa paligid ng mga work span (tapos na ito sa tawag ng WebChat agent). Panatilihing maikli ang mga span at i-reset sa mga block ng `defer` upang maiwasan ang mga na-stuck na animasyon.

Mga hugis at sukat

- Ang base icon ay iginuhit sa `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Ang default na ear scale ay `1.0`; itinatakda ng voice boost ang `earScale=1.9` at tina-toggle ang `earHoles=true` nang hindi binabago ang kabuuang frame (18×18 pt na template image na nirender sa 36×36 px na Retina backing store).
- Gumagamit ang scurry ng leg wiggle hanggang ~1.0 na may maliit na pahalang na jiggle; additive ito sa anumang umiiral na idle wiggle.

Mga tala sa gawi

- Walang external na CLI/broker toggle para sa ears/working; panatilihin itong internal sa sariling mga signal ng app upang maiwasan ang aksidenteng flapping.
- Panatilihing maikli ang mga TTL (&lt;10s) upang mabilis na bumalik sa baseline ang icon kung may job na mag-hang.
