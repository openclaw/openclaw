---
summary: "Mga mode ng voice wake at push-to-talk pati mga detalye ng routing sa mac app"
read_when:
  - Nagtatrabaho sa mga pathway ng voice wake o PTT
title: "Voice Wake"
x-i18n:
  source_path: platforms/mac/voicewake.md
  source_hash: f6440bb89f349ba5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:46Z
---

# Voice Wake & Push-to-Talk

## Mga Mode

- **Wake-word mode** (default): laging naka-on na Speech recognizer na naghihintay ng mga trigger token (`swabbleTriggerWords`). Kapag may tugma, magsisimula itong mag-capture, ipapakita ang overlay na may bahagyang teksto, at awtomatikong magpapadala pagkatapos ng katahimikan.
- **Push-to-talk (hawak ang Right Option)**: hawakan ang right Option key para agad mag-capture—walang kailangang trigger. Lalabas ang overlay habang hawak; kapag binitawan, ito ay magfi-finalize at ipapasa pagkatapos ng maikling delay para ma-adjust mo ang teksto.

## Runtime behavior (wake-word)

- Ang Speech recognizer ay nasa `VoiceWakeRuntime`.
- Ang trigger ay tutunog lang kapag may **makabuluhang paghinto** sa pagitan ng wake word at ng susunod na salita (~0.55s na pagitan). Maaaring magsimula ang overlay/chime sa paghinto kahit bago pa magsimula ang command.
- Mga window ng katahimikan: 2.0s kapag tuloy-tuloy ang pagsasalita, 5.0s kung trigger lang ang narinig.
- Hard stop: 120s para maiwasan ang runaway na mga session.
- Debounce sa pagitan ng mga session: 350ms.
- Ang overlay ay pinapagana sa pamamagitan ng `VoiceWakeOverlayController` na may committed/volatile na coloring.
- Pagkatapos mag-send, malinis na nagre-restart ang recognizer para makinig sa susunod na trigger.

## Mga invariant ng lifecycle

- Kung naka-enable ang Voice Wake at may pahintulot, dapat nakikinig ang wake-word recognizer (maliban kapag may tahasang push-to-talk capture).
- Ang visibility ng overlay (kasama ang manual na pagsara gamit ang X button) ay hindi kailanman dapat pumigil sa recognizer na mag-resume.

## Sticky overlay failure mode (dati)

Dati, kung na-stuck na visible ang overlay at manu-mano mo itong isinara, maaaring magmukhang “patay” ang Voice Wake dahil ang pagtatangkang mag-restart ng runtime ay maaaring maharang ng visibility ng overlay at walang susunod na restart na naka-schedule.

Pagpapatibay:

- Ang restart ng wake runtime ay hindi na nahaharangan ng visibility ng overlay.
- Ang pagkumpleto ng overlay dismiss ay nagti-trigger ng `VoiceWakeRuntime.refresh(...)` sa pamamagitan ng `VoiceSessionCoordinator`, kaya ang manual na X-dismiss ay laging nagre-resume ng pakikinig.

## Mga detalye ng push-to-talk

- Ang hotkey detection ay gumagamit ng global `.flagsChanged` monitor para sa **right Option** (`keyCode 61` + `.option`). Nag-o-observe lang kami ng mga event (walang pag-swallow).
- Ang capture pipeline ay nasa `VoicePushToTalk`: agad nitong sinisimulan ang Speech, nag-i-stream ng mga partial sa overlay, at tinatawag ang `VoiceWakeForwarder` kapag binitawan.
- Kapag nagsimula ang push-to-talk, pini-pause namin ang wake-word runtime para maiwasan ang sabayang audio taps; awtomatiko itong nagre-restart pagkatapos bitawan.
- Mga pahintulot: kailangan ng Microphone + Speech; para makita ang mga event kailangan ng Accessibility/Input Monitoring approval.
- Mga external keyboard: may ilan na maaaring hindi ma-expose ang right Option gaya ng inaasahan—mag-alok ng fallback shortcut kung may mag-ulat ng mga miss.

## Mga setting na nakikita ng user

- **Voice Wake** toggle: ina-enable ang wake-word runtime.
- **Hold Cmd+Fn to talk**: ina-enable ang push-to-talk monitor. Naka-disable sa macOS < 26.
- Language at mic pickers, live level meter, trigger-word table, tester (local-only; hindi nagfo-forward).
- Pinananatili ng mic picker ang huling pinili kung mag-disconnect ang isang device, nagpapakita ng disconnected hint, at pansamantalang bumabalik sa system default hanggang sa bumalik ito.
- **Sounds**: mga chime kapag na-detect ang trigger at kapag nag-send; default sa macOS na “Glass” system sound. Maaari kang pumili ng anumang `NSSound`-loadable na file (hal. MP3/WAV/AIFF) para sa bawat event o pumili ng **No Sound**.

## Forwarding behavior

- Kapag naka-enable ang Voice Wake, ang mga transcript ay ipinapasa sa aktibong gateway/agent (parehong local vs remote mode na ginagamit ng natitirang bahagi ng mac app).
- Ang mga reply ay inihahatid sa **huling ginamit na pangunahing provider** (WhatsApp/Telegram/Discord/WebChat). Kung pumalya ang delivery, nilo-log ang error at nananatiling makikita ang run sa pamamagitan ng WebChat/session logs.

## Forwarding payload

- Ang `VoiceWakeForwarder.prefixedTranscript(_:)` ay naglalagay ng machine hint sa unahan bago magpadala. Ibinabahagi ito sa parehong wake-word at push-to-talk na mga path.

## Mabilis na beripikasyon

- I-toggle ang push-to-talk, hawakan ang Cmd+Fn, magsalita, bitawan: dapat magpakita ang overlay ng mga partial at pagkatapos ay mag-send.
- Habang hawak, dapat manatiling pinalaki ang menu-bar ears (gumagamit ng `triggerVoiceEars(ttl:nil)`); babalik ang mga ito pagkatapos bitawan.
