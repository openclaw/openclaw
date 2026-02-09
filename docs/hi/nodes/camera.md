---
summary: "एजेंट उपयोग के लिए कैमरा कैप्चर (iOS नोड + macOS ऐप): फ़ोटो (jpg) और छोटे वीडियो क्लिप (mp4)"
read_when:
  - iOS नोड्स या macOS पर कैमरा कैप्चर जोड़ते या संशोधित करते समय
  - एजेंट-सुलभ MEDIA अस्थायी-फ़ाइल वर्कफ़्लो का विस्तार करते समय
title: "कैमरा कैप्चर"
---

# कैमरा कैप्चर (एजेंट)

OpenClaw एजेंट वर्कफ़्लो के लिए **कैमरा कैप्चर** का समर्थन करता है:

- **iOS नोड** (Gateway के माध्यम से जोड़ा गया): `node.invoke` के माध्यम से **फ़ोटो** (`jpg`) या **छोटा वीडियो क्लिप** (`mp4`, वैकल्पिक ऑडियो के साथ) कैप्चर करें।
- **Android नोड** (Gateway के माध्यम से जोड़ा गया): `node.invoke` के माध्यम से **फ़ोटो** (`jpg`) या **छोटा वीडियो क्लिप** (`mp4`, वैकल्पिक ऑडियो के साथ) कैप्चर करें।
- **macOS ऐप** (Gateway के माध्यम से नोड): `node.invoke` के माध्यम से **फ़ोटो** (`jpg`) या **छोटा वीडियो क्लिप** (`mp4`, वैकल्पिक ऑडियो के साथ) कैप्चर करें।

सभी कैमरा एक्सेस **उपयोगकर्ता-नियंत्रित सेटिंग्स** के पीछे सीमित हैं।

## iOS नोड

### उपयोगकर्ता सेटिंग (डिफ़ॉल्ट चालू)

- iOS Settings टैब → **Camera** → **Allow Camera** (`camera.enabled`)
  - डिफ़ॉल्ट: **चालू** (गुम कुंजी को सक्षम माना जाता है)।
  - बंद होने पर: `camera.*` कमांड `CAMERA_DISABLED` लौटाते हैं।

### कमांड (Gateway `node.invoke` के माध्यम से)

- `camera.list`
  - प्रतिक्रिया पेलोड:
    - `devices`: `{ id, name, position, deviceType }` की ऐरे

- `camera.snap`
  - पैरामीटर:
    - `facing`: `front|back` (डिफ़ॉल्ट: `front`)
    - `maxWidth`: संख्या (वैकल्पिक; iOS नोड पर डिफ़ॉल्ट `1600`)
    - `quality`: `0..1` (वैकल्पिक; डिफ़ॉल्ट `0.9`)
    - `format`: वर्तमान में `jpg`
    - `delayMs`: संख्या (वैकल्पिक; डिफ़ॉल्ट `0`)
    - `deviceId`: स्ट्रिंग (वैकल्पिक; `camera.list` से)
  - प्रतिक्रिया पेलोड:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - पेलोड गार्ड: फ़ोटो को पुनः-संपीड़ित किया जाता है ताकि base64 पेलोड 5 MB से कम रहे।

- `camera.clip`
  - पैरामीटर:
    - `facing`: `front|back` (डिफ़ॉल्ट: `front`)
    - `durationMs`: संख्या (डिफ़ॉल्ट `3000`, अधिकतम `60000` तक सीमित)
    - `includeAudio`: बूलियन (डिफ़ॉल्ट `true`)
    - `format`: वर्तमान में `mp4`
    - `deviceId`: स्ट्रिंग (वैकल्पिक; `camera.list` से)
  - प्रतिक्रिया पेलोड:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### फ़ोरग्राउंड आवश्यकता

`canvas.*` की तरह, iOS node केवल **foreground** में `camera.*` कमांड्स की अनुमति देता है। Background invocations `NODE_BACKGROUND_UNAVAILABLE` लौटाते हैं।

### CLI सहायक (अस्थायी फ़ाइलें + MEDIA)

अटैचमेंट प्राप्त करने का सबसे आसान तरीका CLI सहायक है, जो डिकोड किए गए मीडिया को एक अस्थायी फ़ाइल में लिखता है और `MEDIA:<path>` प्रिंट करता है।

उदाहरण:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

नोट्स:

- `nodes camera snap` डिफ़ॉल्ट रूप से **दोनों** फ़ेसिंग्स पर सेट होता है ताकि एजेंट को दोनों दृश्य मिलें।
- आउटपुट फ़ाइलें अस्थायी होती हैं (OS टेम्प निर्देशिका में) जब तक आप अपना स्वयं का रैपर न बनाएँ।

## Android नोड

### Android उपयोगकर्ता सेटिंग (डिफ़ॉल्ट चालू)

- Android Settings शीट → **Camera** → **Allow Camera** (`camera.enabled`)
  - डिफ़ॉल्ट: **चालू** (गुम कुंजी को सक्षम माना जाता है)।
  - बंद होने पर: `camera.*` कमांड `CAMERA_DISABLED` लौटाते हैं।

### अनुमतियाँ

- Android को रनटाइम अनुमतियाँ आवश्यक हैं:
  - `CAMERA` दोनों `camera.snap` और `camera.clip` के लिए।
  - `RECORD_AUDIO` `camera.clip` के लिए, जब `includeAudio=true`।

यदि अनुमतियाँ अनुपस्थित हैं, तो ऐप जहाँ संभव हो प्रॉम्प्ट करेगा; यदि अस्वीकार किया गया, तो `camera.*` अनुरोध
`*_PERMISSION_REQUIRED` त्रुटि के साथ विफल हो जाते हैं।

### Android फ़ोरग्राउंड आवश्यकता

`canvas.*` की तरह, Android node केवल **foreground** में `camera.*` कमांड्स की अनुमति देता है। Background invocations `NODE_BACKGROUND_UNAVAILABLE` लौटाते हैं।

### पेलोड गार्ड

फ़ोटो को पुनः-संपीड़ित किया जाता है ताकि base64 पेलोड 5 MB से कम रहे।

## macOS ऐप

### उपयोगकर्ता सेटिंग (डिफ़ॉल्ट बंद)

macOS सहचर ऐप एक चेकबॉक्स प्रदान करता है:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - डिफ़ॉल्ट: **बंद**
  - बंद होने पर: कैमरा अनुरोध “Camera disabled by user” लौटाते हैं।

### CLI सहायक (नोड इन्वोक)

macOS नोड पर कैमरा कमांड इन्वोक करने के लिए मुख्य `openclaw` CLI का उपयोग करें।

उदाहरण:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

नोट्स:

- `openclaw nodes camera snap` डिफ़ॉल्ट रूप से `maxWidth=1600` होता है जब तक ओवरराइड न किया जाए।
- macOS पर, `camera.snap` कैप्चर से पहले वार्म-अप/एक्सपोज़र सेटल होने के बाद `delayMs` (डिफ़ॉल्ट 2000ms) प्रतीक्षा करता है।
- फ़ोटो पेलोड को base64 को 5 MB से कम रखने के लिए पुनः-संपीड़ित किया जाता है।

## सुरक्षा + व्यावहारिक सीमाएँ

- कैमरा और माइक्रोफ़ोन एक्सेस सामान्य OS अनुमति प्रॉम्प्ट ट्रिगर करते हैं (और Info.plist में उपयोग स्ट्रिंग्स की आवश्यकता होती है)।
- वीडियो क्लिप सीमित हैं (वर्तमान में `<= 60s`) ताकि अत्यधिक बड़े नोड पेलोड से बचा जा सके (base64 ओवरहेड + संदेश सीमाएँ)।

## macOS स्क्रीन वीडियो (OS-स्तरीय)

_स्क्रीन_ वीडियो (कैमरा नहीं) के लिए, macOS सहचर का उपयोग करें:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

नोट्स:

- macOS **Screen Recording** अनुमति (TCC) आवश्यक है।
