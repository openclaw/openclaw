---
summary: "Gateway, चैनलों, स्वचालन, नोड्स और ब्राउज़र के लिए गहन समस्या-निवारण रनबुक"
read_when:
  - समस्या-निवारण हब ने आपको गहन निदान के लिए यहाँ भेजा है
  - आपको सटीक कमांड्स के साथ स्थिर, लक्षण-आधारित रनबुक अनुभागों की आवश्यकता है
title: "समस्या-निवारण"
---

# Gateway समस्या-निवारण

This page is the deep runbook.
Start at [/help/troubleshooting](/help/troubleshooting) if you want the fast triage flow first.

## कमांड सीढ़ी

इन कमांड्स को पहले, इसी क्रम में चलाएँ:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

अपेक्षित स्वस्थ संकेत:

- `openclaw gateway status` में `Runtime: running` और `RPC probe: ok` दिखाई देते हैं।
- `openclaw doctor` किसी भी ब्लॉकिंग विन्यास/सेवा समस्या की रिपोर्ट नहीं करता।
- `openclaw channels status --probe` कनेक्टेड/तैयार चैनल दिखाता है।

## कोई उत्तर नहीं

यदि चैनल चालू हैं लेकिन कोई उत्तर नहीं आ रहा, तो किसी भी चीज़ को पुनः कनेक्ट करने से पहले रूटिंग और नीति की जाँच करें।

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

देखें:

- DM प्रेषकों के लिए पेयरिंग लंबित।
- समूह मेंशन गेटिंग (`requireMention`, `mentionPatterns`)।
- चैनल/समूह अनुमति-सूची (allowlist) में असंगति।

सामान्य संकेत:

- `drop guild message (mention required` → मेंशन होने तक समूह संदेश अनदेखा।
- `pairing request` → प्रेषक को अनुमोदन चाहिए।
- `blocked` / `allowlist` → प्रेषक/चैनल नीति द्वारा फ़िल्टर किया गया।

संबंधित:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## डैशबोर्ड नियंत्रण UI कनेक्टिविटी

जब डैशबोर्ड/कंट्रोल UI कनेक्ट नहीं होता, तो URL, प्रमाणीकरण मोड और सुरक्षित संदर्भ की मान्यताओं की जाँच करें।

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

देखें:

- सही प्रोब URL और डैशबोर्ड URL।
- क्लाइंट और Gateway के बीच प्रमाणीकरण मोड/टोकन का असंगत होना।
- जहाँ डिवाइस पहचान आवश्यक है वहाँ HTTP का उपयोग।

सामान्य संकेत:

- `device identity required` → असुरक्षित संदर्भ या डिवाइस प्रमाणीकरण अनुपस्थित।
- `unauthorized` / पुनःकनेक्ट लूप → टोकन/पासवर्ड असंगति।
- `gateway connect failed:` → गलत होस्ट/पोर्ट/URL लक्ष्य।

संबंधित:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway सेवा चल नहीं रही

जब सेवा इंस्टॉल है लेकिन प्रक्रिया चालू नहीं रहती, तब इसका उपयोग करें।

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

देखें:

- निकास संकेतों के साथ `Runtime: stopped`।
- सेवा विन्यास असंगति (`Config (cli)` बनाम `Config (service)`)।
- पोर्ट/लिस्नर टकराव।

सामान्य संकेत:

- `Gateway start blocked: set gateway.mode=local` → स्थानीय Gateway मोड सक्षम नहीं है।
- `refusing to bind gateway ... without auth` → non-loopback bind without token/password.
- `another gateway instance is already listening` / `EADDRINUSE` → पोर्ट टकराव।

संबंधित:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## चैनल कनेक्टेड है लेकिन संदेश प्रवाह नहीं

यदि चैनल की स्थिति कनेक्टेड है लेकिन संदेश प्रवाह बंद है, तो नीति, अनुमतियाँ और चैनल-विशिष्ट डिलीवरी नियमों पर ध्यान दें।

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

देखें:

- DM नीति (`pairing`, `allowlist`, `open`, `disabled`)।
- समूह allowlist और मेंशन आवश्यकताएँ।
- चैनल API अनुमतियाँ/स्कोप्स का अभाव।

सामान्य संकेत:

- `mention required` → समूह मेंशन नीति द्वारा संदेश अनदेखा।
- `pairing` / लंबित अनुमोदन ट्रेस → प्रेषक अनुमोदित नहीं है।
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → चैनल प्रमाणीकरण/अनुमति समस्या।

संबंधित:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## क्रॉन और हार्टबीट डिलीवरी

यदि क्रॉन या हार्टबीट नहीं चला या डिलीवर नहीं हुआ, तो पहले शेड्यूलर की स्थिति जाँचें, फिर डिलीवरी लक्ष्य।

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

देखें:

- क्रॉन सक्षम है और अगला वेक मौजूद है।
- जॉब रन इतिहास की स्थिति (`ok`, `skipped`, `error`)।
- हार्टबीट स्किप कारण (`quiet-hours`, `requests-in-flight`, `alerts-disabled`)।

सामान्य संकेत:

- `cron: scheduler disabled; jobs will not run automatically` → क्रॉन अक्षम।
- `cron: timer tick failed` → शेड्यूलर टिक विफल; फ़ाइल/लॉग/रनटाइम त्रुटियाँ जाँचें।
- `heartbeat skipped` के साथ `reason=quiet-hours` → सक्रिय घंटों की विंडो से बाहर।
- `heartbeat: unknown accountId` → हार्टबीट डिलीवरी लक्ष्य के लिए अमान्य अकाउंट आईडी।

संबंधित:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## नोड पेयर्ड है लेकिन टूल विफल

यदि कोई नोड पेयर्ड है लेकिन टूल्स विफल हैं, तो फ़ोरग्राउंड, अनुमतियाँ और अनुमोदन स्थिति को अलग करें।

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

देखें:

- अपेक्षित क्षमताओं के साथ नोड ऑनलाइन।
- कैमरा/माइक/लोकेशन/स्क्रीन के लिए OS अनुमति अनुदान।
- Exec अनुमोदन और allowlist स्थिति।

सामान्य संकेत:

- `NODE_BACKGROUND_UNAVAILABLE` → नोड ऐप फ़ोरग्राउंड में होना चाहिए।
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS अनुमति अनुपस्थित।
- `SYSTEM_RUN_DENIED: approval required` → exec अनुमोदन लंबित।
- `SYSTEM_RUN_DENIED: allowlist miss` → allowlist द्वारा कमांड अवरुद्ध।

संबंधित:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## ब्राउज़र टूल विफल

जब Gateway स्वयं स्वस्थ हो लेकिन ब्राउज़र टूल क्रियाएँ विफल हों, तब इसका उपयोग करें।

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

देखें:

- वैध ब्राउज़र executable पथ।
- CDP प्रोफ़ाइल की पहुँचयोग्यता।
- `profile="chrome"` के लिए एक्सटेंशन रिले टैब अटैचमेंट।

सामान्य संकेत:

- `Failed to start Chrome CDP on port` → ब्राउज़र प्रक्रिया लॉन्च होने में विफल।
- `browser.executablePath not found` → विन्यस्त पथ अमान्य है।
- `Chrome extension relay is running, but no tab is connected` → एक्सटेंशन रिले संलग्न नहीं।
- `Browser attachOnly is enabled ... not reachable` → attach-only profile has no reachable target.

संबंधित:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## यदि आपने अपग्रेड किया और अचानक कुछ टूट गया

अधिकांश पोस्ट-अपग्रेड समस्याएँ विन्यास ड्रिफ्ट या अब लागू किए जा रहे अधिक सख्त डिफ़ॉल्ट्स के कारण होती हैं।

### 1. प्रमाणीकरण और URL ओवरराइड व्यवहार बदला

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

क्या जाँचें:

- यदि `gateway.mode=remote`, तो CLI कॉल्स रिमोट को लक्षित कर सकती हैं जबकि आपकी स्थानीय सेवा ठीक है।
- स्पष्ट `--url` कॉल्स संग्रहीत क्रेडेंशियल्स पर फ़ॉलबैक नहीं करतीं।

सामान्य संकेत:

- `gateway connect failed:` → गलत URL लक्ष्य।
- `unauthorized` → एंडपॉइंट पहुँचयोग्य है लेकिन प्रमाणीकरण गलत है।

### 2. बाइंड और प्रमाणीकरण गार्डरेल्स अधिक सख्त हैं

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

क्या जाँचें:

- non-loopback बाइंड्स (`lan`, `tailnet`, `custom`) के लिए प्रमाणीकरण विन्यस्त होना चाहिए।
- पुराने कुंजियाँ जैसे `gateway.token` , `gateway.auth.token` को प्रतिस्थापित नहीं करतीं।

सामान्य संकेत:

- `refusing to bind gateway ... without auth` → bind+auth mismatch.
- रनटाइम चलते समय `RPC probe: failed` → Gateway जीवित है लेकिन वर्तमान प्रमाणीकरण/URL के साथ पहुँच से बाहर है।

### 3. पेयरिंग और डिवाइस पहचान स्थिति बदली

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

क्या जाँचें:

- डैशबोर्ड/नोड्स के लिए लंबित डिवाइस अनुमोदन।
- नीति या पहचान परिवर्तनों के बाद लंबित DM पेयरिंग अनुमोदन।

सामान्य संकेत:

- `device identity required` → डिवाइस प्रमाणीकरण संतुष्ट नहीं।
- `pairing required` → प्रेषक/डिवाइस को अनुमोदित करना आवश्यक है।

यदि जाँच के बाद भी सेवा विन्यास और रनटाइम में असहमति बनी रहती है, तो उसी प्रोफ़ाइल/स्टेट डायरेक्टरी से सेवा मेटाडेटा पुनःइंस्टॉल करें:

```bash
openclaw gateway install --force
openclaw gateway restart
```

संबंधित:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
