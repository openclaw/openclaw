---
summary: "ClawHub मार्गदर्शिका: सार्वजनिक Skills रजिस्ट्री + CLI वर्कफ़्लो"
read_when:
  - नए उपयोगकर्ताओं को ClawHub का परिचय देते समय
  - Skills को इंस्टॉल करने, खोजने या प्रकाशित करने के लिए
  - ClawHub CLI फ़्लैग्स और सिंक व्यवहार की व्याख्या करते समय
title: "ClawHub"
---

# ClawHub

30. ClawHub **OpenClaw के लिए public skill registry** है। 31. यह एक free service है: सभी skills public, open, और सभी के लिए sharing और reuse के लिए visible हैं। 32. एक skill बस एक folder होती है जिसमें `SKILL.md` file (और supporting text files) होती हैं। 33. आप web app में skills browse कर सकते हैं या CLI का उपयोग करके skills search, install, update, और publish कर सकते हैं।

साइट: [clawhub.ai](https://clawhub.ai)

## ClawHub क्या है

- OpenClaw Skills के लिए एक सार्वजनिक रजिस्ट्री।
- Skill बंडलों और मेटाडेटा का एक संस्करणित भंडार।
- खोज, टैग्स और उपयोग संकेतों के लिए एक डिस्कवरी सतह।

## यह कैसे काम करता है

1. एक उपयोगकर्ता एक Skill बंडल (फ़ाइलें + मेटाडेटा) प्रकाशित करता है।
2. ClawHub बंडल को संग्रहीत करता है, मेटाडेटा पार्स करता है और एक संस्करण असाइन करता है।
3. रजिस्ट्री खोज और डिस्कवरी के लिए Skill को इंडेक्स करती है।
4. उपयोगकर्ता OpenClaw में Skills ब्राउज़, डाउनलोड और इंस्टॉल करते हैं।

## आप क्या कर सकते हैं

- नई Skills और मौजूदा Skills के नए संस्करण प्रकाशित करना।
- नाम, टैग्स या खोज द्वारा Skills की खोज करना।
- Skill बंडल डाउनलोड करना और उनकी फ़ाइलों का निरीक्षण करना।
- अपमानजनक या असुरक्षित Skills की रिपोर्ट करना।
- यदि आप एक मॉडरेटर हैं, तो छिपाना, दिखाना, हटाना या प्रतिबंधित करना।

## यह किसके लिए है (शुरुआती‑अनुकूल)

34. यदि आप अपने OpenClaw agent में नई capabilities जोड़ना चाहते हैं, तो ClawHub skills खोजने और install करने का सबसे आसान तरीका है। 35. आपको backend के काम करने का तरीका जानने की आवश्यकता नहीं है। 36. आप कर सकते हैं:

- साधारण भाषा में Skills खोजें।
- अपने वर्कस्पेस में एक Skill इंस्टॉल करें।
- एक कमांड से बाद में Skills अपडेट करें।
- अपनी स्वयं की Skills को प्रकाशित करके बैक अप लें।

## त्वरित प्रारंभ (गैर‑तकनीकी)

1. CLI इंस्टॉल करें (अगला अनुभाग देखें)।
2. अपनी आवश्यकता की चीज़ खोजें:
   - `clawhub search "calendar"`
3. एक Skill इंस्टॉल करें:
   - `clawhub install <skill-slug>`
4. एक नया OpenClaw सत्र प्रारंभ करें ताकि नई Skill लोड हो सके।

## CLI इंस्टॉल करें

इनमें से एक चुनें:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw में यह कैसे फिट होता है

37. By default, CLI आपके current working directory के अंतर्गत `./skills` में skills install करता है। 38. यदि कोई OpenClaw workspace configured है, तो `clawhub` `--workdir` (या `CLAWHUB_WORKDIR`) से override न करने पर उसी workspace पर fallback करता है। 39. OpenClaw `<workspace>/skills` से workspace skills load करता है और उन्हें **next** session में pick up करेगा। 40. यदि आप पहले से `~/.openclaw/skills` या bundled skills का उपयोग करते हैं, तो workspace skills को प्राथमिकता दी जाती है।

Skills कैसे लोड, साझा और नियंत्रित की जाती हैं, इसके बारे में अधिक विवरण के लिए देखें:
[Skills](/tools/skills)

## Skill सिस्टम का अवलोकन

41. एक skill files का एक versioned bundle होता है जो OpenClaw को एक
    specific task करने का तरीका सिखाता है। 42. हर publish एक नया version बनाता है, और registry versions का
    history रखती है ताकि users changes का audit कर सकें।

एक सामान्य Skill में शामिल होता है:

- प्राथमिक विवरण और उपयोग के साथ एक `SKILL.md` फ़ाइल।
- वैकल्पिक कॉन्फ़िग्स, स्क्रिप्ट्स या सहायक फ़ाइलें।
- टैग्स, सारांश और इंस्टॉल आवश्यकताओं जैसे मेटाडेटा।

43. ClawHub discovery को power करने और skill capabilities को सुरक्षित रूप से expose करने के लिए metadata का उपयोग करता है।
44. Registry ranking और visibility सुधारने के लिए usage signals (जैसे stars और downloads) को भी track करती है।

## सेवा क्या प्रदान करती है (विशेषताएँ)

- Skills और उनकी `SKILL.md` सामग्री का **सार्वजनिक ब्राउज़िंग**।
- केवल कीवर्ड्स नहीं, बल्कि एम्बेडिंग्स (वेक्टर खोज) द्वारा संचालित **खोज**।
- **संस्करण प्रबंधन** जिसमें semver, चेंजलॉग्स और टैग्स शामिल हैं (जिनमें `latest` शामिल है)।
- प्रति संस्करण **ज़िप के रूप में डाउनलोड**।
- सामुदायिक प्रतिक्रिया के लिए **स्टार्स और टिप्पणियाँ**।
- अनुमोदन और ऑडिट के लिए **मॉडरेशन** हुक्स।
- स्वचालन और स्क्रिप्टिंग के लिए **CLI‑अनुकूल API**।

## सुरक्षा और मॉडरेशन

45. ClawHub by default open है। 46. कोई भी skills upload कर सकता है, लेकिन publish करने के लिए GitHub account
    कम से कम एक सप्ताह पुराना होना चाहिए। 47. यह legitimate contributors को block किए बिना abuse को धीमा करने में मदद करता है।

रिपोर्टिंग और मॉडरेशन:

- कोई भी साइन‑इन किया हुआ उपयोगकर्ता Skill की रिपोर्ट कर सकता है।
- रिपोर्ट के कारण अनिवार्य हैं और दर्ज किए जाते हैं।
- प्रत्येक उपयोगकर्ता एक समय में अधिकतम 20 सक्रिय रिपोर्ट रख सकता है।
- 3 से अधिक अद्वितीय रिपोर्ट वाली Skills डिफ़ॉल्ट रूप से स्वतः छिपा दी जाती हैं।
- मॉडरेटर छिपी हुई Skills देख सकते हैं, उन्हें दिखा सकते हैं, हटा सकते हैं या उपयोगकर्ताओं को प्रतिबंधित कर सकते हैं।
- रिपोर्ट सुविधा का दुरुपयोग करने पर खाते पर प्रतिबंध लग सकता है।

48. Moderator बनने में रुचि है? 49. OpenClaw Discord में पूछें और किसी
    moderator या maintainer से संपर्क करें।

## CLI कमांड्स और पैरामीटर

वैश्विक विकल्प (सभी कमांड्स पर लागू):

- `--workdir <dir>`: कार्य निर्देशिका (डिफ़ॉल्ट: वर्तमान निर्देशिका; OpenClaw वर्कस्पेस पर फ़ॉलबैक)।
- `--dir <dir>`: Skills निर्देशिका, workdir के सापेक्ष (डिफ़ॉल्ट: `skills`)।
- `--site <url>`: साइट बेस URL (ब्राउज़र लॉगिन)।
- `--registry <url>`: रजिस्ट्री API बेस URL।
- `--no-input`: प्रॉम्प्ट्स अक्षम करें (नॉन‑इंटरैक्टिव)।
- `-V, --cli-version`: CLI संस्करण प्रिंट करें।

Auth:

- `clawhub login` (ब्राउज़र फ़्लो) या `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

विकल्प:

- `--token <token>`: एक API टोकन पेस्ट करें।
- `--label <label>`: ब्राउज़र लॉगिन टोकन के लिए संग्रहीत लेबल (डिफ़ॉल्ट: `CLI token`)।
- `--no-browser`: ब्राउज़र न खोलें (आवश्यक: `--token`)।

खोज:

- `clawhub search "query"`
- `--limit <n>`: अधिकतम परिणाम।

इंस्टॉल:

- `clawhub install <slug>`
- `--version <version>`: एक विशिष्ट संस्करण इंस्टॉल करें।
- `--force`: यदि फ़ोल्डर पहले से मौजूद हो तो ओवरराइट करें।

अपडेट:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: एक विशिष्ट संस्करण पर अपडेट करें (केवल एक स्लग)।
- `--force`: जब स्थानीय फ़ाइलें किसी प्रकाशित संस्करण से मेल न खाएँ तो ओवरराइट करें।

सूची:

- `clawhub list` (`.clawhub/lock.json` पढ़ता है)

प्रकाशित करें:

- `clawhub publish <path>`
- `--slug <slug>`: Skill स्लग।
- `--name <name>`: प्रदर्शित नाम।
- `--version <version>`: Semver संस्करण।
- `--changelog <text>`: चेंजलॉग टेक्स्ट (खाली हो सकता है)।
- `--tags <tags>`: कॉमा‑सेपरेटेड टैग्स (डिफ़ॉल्ट: `latest`)।

हटाना/पुनर्स्थापित करना (केवल मालिक/एडमिन):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

सिंक (स्थानीय Skills स्कैन करें + नई/अपडेटेड प्रकाशित करें):

- `clawhub sync`
- `--root <dir...>`: अतिरिक्त स्कैन रूट्स।
- `--all`: बिना प्रॉम्प्ट के सब कुछ अपलोड करें।
- `--dry-run`: क्या अपलोड होगा यह दिखाएँ।
- `--bump <type>`: अपडेट्स के लिए `patch|minor|major` (डिफ़ॉल्ट: `patch`)।
- `--changelog <text>`: नॉन‑इंटरैक्टिव अपडेट्स के लिए चेंजलॉग।
- `--tags <tags>`: कॉमा‑सेपरेटेड टैग्स (डिफ़ॉल्ट: `latest`)।
- `--concurrency <n>`: रजिस्ट्री जाँचें (डिफ़ॉल्ट: 4)।

## एजेंट्स के लिए सामान्य वर्कफ़्लो

### Skills खोजें

```bash
clawhub search "postgres backups"
```

### नई Skills डाउनलोड करें

```bash
clawhub install my-skill-pack
```

### इंस्टॉल की गई Skills अपडेट करें

```bash
clawhub update --all
```

### अपनी Skills का बैक अप लें (प्रकाशित या सिंक करें)

एकल Skill फ़ोल्डर के लिए:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

एक साथ कई Skills स्कैन और बैक अप करने के लिए:

```bash
clawhub sync --all
```

## उन्नत विवरण (तकनीकी)

### संस्करण प्रबंधन और टैग्स

- प्रत्येक प्रकाशन एक नया **semver** `SkillVersion` बनाता है।
- टैग्स (जैसे `latest`) किसी संस्करण की ओर संकेत करते हैं; टैग्स को स्थानांतरित करके आप रोल‑बैक कर सकते हैं।
- चेंजलॉग्स प्रति संस्करण संलग्न होते हैं और सिंक या अपडेट प्रकाशित करते समय खाली हो सकते हैं।

### स्थानीय परिवर्तन बनाम रजिस्ट्री संस्करण

50. Updates content hash का उपयोग करके local skill contents की तुलना registry versions से करते हैं। यदि स्थानीय फ़ाइलें किसी प्रकाशित संस्करण से मेल नहीं खातीं, तो CLI ओवरराइट करने से पहले पूछता है (या गैर‑इंटरैक्टिव रन में `--force` की आवश्यकता होती है)।

### सिंक स्कैनिंग और फ़ॉलबैक रूट्स

`clawhub sync` पहले आपकी वर्तमान workdir को स्कैन करता है। यदि कोई skills नहीं मिलतीं, तो यह ज्ञात legacy स्थानों पर वापस जाता है (उदाहरण के लिए `~/openclaw/skills` और `~/.openclaw/skills`)। यह अतिरिक्त फ़्लैग्स के बिना पुराने skill installs खोजने के लिए डिज़ाइन किया गया है।

### स्टोरेज और लॉकफ़ाइल

- इंस्टॉल की गई Skills आपकी workdir के अंतर्गत `.clawhub/lock.json` में दर्ज की जाती हैं।
- Auth टोकन ClawHub CLI कॉन्फ़िग फ़ाइल में संग्रहीत होते हैं ( `CLAWHUB_CONFIG_PATH` के माध्यम से ओवरराइड करें)।

### टेलीमेट्री (इंस्टॉल काउंट)

जब आप लॉग इन रहते हुए `clawhub sync` चलाते हैं, तो CLI install counts की गणना के लिए एक न्यूनतम snapshot भेजता है। आप इसे पूरी तरह अक्षम कर सकते हैं:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## पर्यावरण चर

- `CLAWHUB_SITE`: साइट URL ओवरराइड करें।
- `CLAWHUB_REGISTRY`: रजिस्ट्री API URL ओवरराइड करें।
- `CLAWHUB_CONFIG_PATH`: CLI टोकन/कॉन्फ़िग कहाँ संग्रहीत करे, इसे ओवरराइड करें।
- `CLAWHUB_WORKDIR`: डिफ़ॉल्ट workdir ओवरराइड करें।
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync` पर टेलीमेट्री अक्षम करें।
