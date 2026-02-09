---
summary: "नोड्स के लिए Location कमांड (location.get), अनुमति मोड, और बैकग्राउंड व्यवहार"
read_when:
  - Location नोड सपोर्ट या अनुमति UI जोड़ते समय
  - बैकग्राउंड Location + पुश फ्लो डिज़ाइन करते समय
title: "Location कमांड"
---

# Location कमांड (नोड्स)

## TL;DR

- `location.get` एक नोड कमांड है (`node.invoke` के माध्यम से)।
- डिफ़ॉल्ट रूप से बंद।
- सेटिंग्स में एक सेलेक्टर उपयोग होता है: Off / While Using / Always।
- अलग टॉगल: Precise Location।

## सेलेक्टर क्यों (सिर्फ़ स्विच क्यों नहीं)

हम ऐप में एक selector एक्सपोज़ कर सकते हैं, लेकिन वास्तविक अनुमति OS ही तय करता है। iOS/macOS: उपयोगकर्ता सिस्टम प्रॉम्प्ट्स/Settings में **While Using** या **Always** चुन सकता है।

- ऐप अपग्रेड का अनुरोध कर सकता है, लेकिन OS को Settings की आवश्यकता हो सकती है। वैकल्पिक।
- Android: बैकग्राउंड Location एक अलग अनुमति है; Android 10+ पर अक्सर सेटिंग्स फ्लो आवश्यक होता है।
- Precise Location एक अलग अनुमति है (iOS 14+ “Precise”, Android में “fine” बनाम “coarse”)।

UI में सेलेक्टर हमारे अनुरोधित मोड को संचालित करता है; वास्तविक अनुमति OS सेटिंग्स में रहती है।

## Settings मॉडल

प्रति नोड डिवाइस:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI व्यवहार:

- `whileUsing` चुनने पर foreground अनुमति का अनुरोध किया जाता है।
- `always` चुनने पर पहले `whileUsing` सुनिश्चित किया जाता है, फिर बैकग्राउंड का अनुरोध किया जाता है (या आवश्यकता होने पर उपयोगकर्ता को Settings पर भेजा जाता है)।
- यदि OS अनुरोधित स्तर को अस्वीकार करता है, तो सबसे उच्च अनुमत स्तर पर वापस जाएँ और स्थिति दिखाएँ।

## Permissions mapping (node.permissions)

macOS node permissions मैप के माध्यम से `location` रिपोर्ट करता है; iOS/Android इसे छोड़ सकते हैं। iOS: Always अनुमति + background location मोड आवश्यक है।

## Command: `location.get`

`node.invoke` के माध्यम से कॉल किया जाता है।

Params (सुझावित):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Response payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Errors (स्थिर कोड):

- `LOCATION_DISABLED`: सेलेक्टर बंद है।
- `LOCATION_PERMISSION_REQUIRED`: अनुरोधित मोड के लिए अनुमति अनुपस्थित है।
- `LOCATION_BACKGROUND_UNAVAILABLE`: ऐप बैकग्राउंड में है, लेकिन केवल While Using की अनुमति है।
- `LOCATION_TIMEOUT`: समय पर फ़िक्स नहीं मिला।
- `LOCATION_UNAVAILABLE`: सिस्टम विफलता / कोई प्रदाता नहीं।

## बैकग्राउंड व्यवहार (भविष्य)

लक्ष्य: मॉडल नोड के बैकग्राउंड में होने पर भी Location का अनुरोध कर सके, लेकिन केवल तब जब:

- उपयोगकर्ता ने **Always** चुना हो।
- OS बैकग्राउंड Location की अनुमति देता हो।
- ऐप को Location के लिए बैकग्राउंड में चलने की अनुमति हो (iOS बैकग्राउंड मोड / Android foreground service या विशेष अनुमति)।

पुश-ट्रिगर फ्लो (भविष्य):

1. Gateway नोड को एक पुश भेजता है (silent push या FCM data)।
2. नोड थोड़े समय के लिए जागता है और डिवाइस से Location का अनुरोध करता है।
3. नोड payload को Gateway को अग्रेषित करता है।

नोट्स:

- Silent push throttled हो सकता है; बीच‑बीच में विफलताओं की अपेक्षा करें। Always: “Allow background location.
- Android: बैकग्राउंड Location के लिए foreground service आवश्यक हो सकती है; अन्यथा, अस्वीकृति की अपेक्षा करें।

## Model/tooling integration

- Tool surface: `nodes` टूल `location_get` action जोड़ता है (नोड आवश्यक)।
- CLI: `openclaw nodes location get --node <id>`।
- Agent दिशानिर्देश: केवल तब कॉल करें जब उपयोगकर्ता ने Location सक्षम किया हो और दायरे को समझता हो।

## UX कॉपी (सुझावित)

- Off: “Location sharing अक्षम है।”
- While Using: “केवल तब जब OpenClaw खुला हो।”
- Requires system permission.” Precise: “Use precise GPS location.
- Toggle off to share approximate location.” OpenClaw reply pipeline चलने से पहले **inbound media** (image/audio/video) का **सारांश** बना सकता है।
