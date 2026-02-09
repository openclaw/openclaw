---
summary: "Mga mode ng voice wake at push-to-talk pati mga detalye ng routing sa mac app"
read_when:
  - Nagtatrabaho sa mga pathway ng voice wake o PTT
title: "Voice Wake"
---

# Voice Wake & Push-to-Talk

## Mga Mode

- 31. **Wake-word mode** (default): palaging naka-on na Speech recognizer ang naghihintay ng mga trigger token (`swabbleTriggerWords`). 32. Sa pagtugma, nagsisimula ito ng capture, ipinapakita ang overlay na may partial text, at awtomatikong nagse-send matapos ang katahimikan.
- 33. **Push-to-talk (Right Option hold)**: hawakan ang kanang Option key para agad na mag-capture—walang trigger na kailangan. 34. Lumalabas ang overlay habang nakahawak; ang pagbitaw ay nagfi-finalize at nagpapasa matapos ang maikling delay upang makapag-tweak ka ng text.

## Runtime behavior (wake-word)

- Ang Speech recognizer ay nasa `VoiceWakeRuntime`.
- 35. Nagfi-fire lang ang trigger kapag may **makabuluhang pause** sa pagitan ng wake word at ng susunod na salita (~0.55s na gap). 36. Maaaring magsimula ang overlay/chime sa pause kahit bago pa magsimula ang command.
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

- 37. Gumagamit ang hotkey detection ng global `.flagsChanged` monitor para sa **right Option** (`keyCode 61` + `.option`). Nag-oobserba lang kami ng mga event (walang pagharang).
- Ang capture pipeline ay nasa `VoicePushToTalk`: agad nitong sinisimulan ang Speech, nag-i-stream ng mga partial sa overlay, at tinatawag ang `VoiceWakeForwarder` kapag binitawan.
- Kapag nagsimula ang push-to-talk, pini-pause namin ang wake-word runtime para maiwasan ang sabayang audio taps; awtomatiko itong nagre-restart pagkatapos bitawan.
- Mga pahintulot: kailangan ng Microphone + Speech; para makita ang mga event kailangan ng Accessibility/Input Monitoring approval.
- Mga external keyboard: may ilan na maaaring hindi ma-expose ang right Option gaya ng inaasahan—mag-alok ng fallback shortcut kung may mag-ulat ng mga miss.

## Mga setting na nakikita ng user

- **Voice Wake** toggle: ina-enable ang wake-word runtime.
- 38. **Hawakan ang Cmd+Fn para magsalita**: pinapagana ang push-to-talk monitor. 39. Naka-disable sa macOS < 26.
- Language at mic pickers, live level meter, trigger-word table, tester (local-only; hindi nagfo-forward).
- Pinananatili ng mic picker ang huling pinili kung mag-disconnect ang isang device, nagpapakita ng disconnected hint, at pansamantalang bumabalik sa system default hanggang sa bumalik ito.
- 40. **Mga Tunog**: may chime sa trigger detect at sa send; default ang macOS “Glass” system sound. 41. Maaari kang pumili ng anumang `NSSound`-loadable na file (hal. MP3/WAV/AIFF) para sa bawat event o piliin ang **No Sound**.

## Forwarding behavior

- Kapag naka-enable ang Voice Wake, ang mga transcript ay ipinapasa sa aktibong gateway/agent (parehong local vs remote mode na ginagamit ng natitirang bahagi ng mac app).
- 42. Ang mga sagot ay inihahatid sa **huling ginamit na main provider** (WhatsApp/Telegram/Discord/WebChat). 43. Kapag nabigo ang delivery, nilolog ang error at nananatiling nakikita ang run sa pamamagitan ng WebChat/session logs.

## Forwarding payload

- 44. Ang `VoiceWakeForwarder.prefixedTranscript(_:)` ay nagpe-prepend ng machine hint bago magpadala. Ibinabahagi sa pagitan ng wake-word at push-to-talk na mga path.

## Mabilis na beripikasyon

- I-toggle ang push-to-talk, hawakan ang Cmd+Fn, magsalita, bitawan: dapat magpakita ang overlay ng mga partial at pagkatapos ay mag-send.
- Habang hawak, dapat manatiling pinalaki ang menu-bar ears (gumagamit ng `triggerVoiceEars(ttl:nil)`); babalik ang mga ito pagkatapos bitawan.
