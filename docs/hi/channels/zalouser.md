---
summary: "zca-cli (QR लॉगिन) के माध्यम से Zalo व्यक्तिगत खाते का समर्थन, क्षमताएँ और विन्यास"
read_when:
  - OpenClaw के लिए Zalo Personal सेटअप करना
  - Zalo Personal लॉगिन या संदेश प्रवाह का डीबग करना
title: "Zalo Personal"
---

# Zalo Personal (अनौपचारिक)

स्थिति: प्रायोगिक। यह इंटीग्रेशन `zca-cli` के माध्यम से एक **व्यक्तिगत Zalo खाता** स्वचालित करता है।

> **चेतावनी:** यह एक अनौपचारिक इंटीग्रेशन है और इससे खाता निलंबन/प्रतिबंध हो सकता है। अपने जोखिम पर उपयोग करें।

## आवश्यक प्लगइन

Zalo Personal एक प्लगइन के रूप में उपलब्ध है और कोर इंस्टॉल के साथ बंडल नहीं है।

- CLI के माध्यम से इंस्टॉल करें: `openclaw plugins install @openclaw/zalouser`
- या स्रोत चेकआउट से: `openclaw plugins install ./extensions/zalouser`
- विवरण: [Plugins](/tools/plugin)

## पूर्वापेक्षा: zca-cli

Gateway मशीन पर `zca` बाइनरी `PATH` में उपलब्ध होनी चाहिए।

- सत्यापित करें: `zca --version`
- यदि अनुपलब्ध हो, तो zca-cli इंस्टॉल करें (देखें `extensions/zalouser/README.md` या अपस्ट्रीम zca-cli दस्तावेज़)।

## त्वरित सेटअप (शुरुआती)

1. प्लगइन इंस्टॉल करें (ऊपर देखें)।
2. लॉगिन करें (QR, Gateway मशीन पर):
   - `openclaw channels login --channel zalouser`
   - टर्मिनल में दिखे QR कोड को Zalo मोबाइल ऐप से स्कैन करें।
3. चैनल सक्षम करें:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Gateway को पुनः आरंभ करें (या ऑनबोर्डिंग पूर्ण करें)।
5. DM एक्सेस डिफ़ॉल्ट रूप से पेयरिंग पर सेट होता है; पहली संपर्क पर पेयरिंग कोड को स्वीकृत करें।

## यह क्या है

- इनबाउंड संदेश प्राप्त करने के लिए `zca listen` का उपयोग करता है।
- उत्तर भेजने (टेक्स्ट/मीडिया/लिंक) के लिए `zca msg ...` का उपयोग करता है।
- उन “व्यक्तिगत खाता” उपयोग मामलों के लिए डिज़ाइन किया गया है जहाँ Zalo Bot API उपलब्ध नहीं है।

## नामकरण

चैनल id `zalouser` है ताकि यह स्पष्ट हो कि यह एक **व्यक्तिगत Zalo उपयोगकर्ता खाता** (अनौपचारिक) स्वचालित करता है। हम `zalo` को भविष्य में संभावित आधिकारिक Zalo API इंटीग्रेशन के लिए आरक्षित रखते हैं।

## IDs खोजना (डायरेक्टरी)

सहकर्मियों/समूहों और उनके IDs खोजने के लिए डायरेक्टरी CLI का उपयोग करें:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## सीमाएँ

- आउटबाउंड टेक्स्ट ~2000 अक्षरों में खंडित किया जाता है (Zalo क्लाइंट सीमाएँ)।
- स्ट्रीमिंग डिफ़ॉल्ट रूप से अवरुद्ध है।

## प्रवेश नियंत्रण (DMs)

`channels.zalouser.dmPolicy` समर्थन करता है: `pairing | allowlist | open | disabled` (डिफ़ॉल्ट: `pairing`)।
`channels.zalouser.allowFrom` उपयोगकर्ता IDs या नाम स्वीकार करता है। विज़ार्ड उपलब्ध होने पर `zca friend find` के माध्यम से नामों को IDs में बदल देता है।

स्वीकृति दें:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## समूह प्रवेश (वैकल्पिक)

- डिफ़ॉल्ट: `channels.zalouser.groupPolicy = "open"` (समूहों की अनुमति)। जब सेट न हो, डिफ़ॉल्ट को ओवरराइड करने के लिए `channels.defaults.groupPolicy` का उपयोग करें।
- अनुमति-सूची (allowlist) तक सीमित करें:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (कुंजियाँ समूह IDs या नाम हैं)
- सभी समूह अवरुद्ध करें: `channels.zalouser.groupPolicy = "disabled"`।
- कॉन्फ़िगर विज़ार्ड समूह अनुमति-सूचियों के लिए संकेत दे सकता है।
- स्टार्टअप पर, OpenClaw अनुमति-सूचियों में समूह/उपयोगकर्ता नामों को IDs में परिवर्तित करता है और मैपिंग लॉग करता है; जिन प्रविष्टियों का समाधान नहीं होता, उन्हें जैसा टाइप किया गया है वैसा ही रखा जाता है।

उदाहरण:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## बहु-खाता

खाते zca प्रोफाइल से मैप होते हैं। उदाहरण:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## समस्या-निवारण

**`zca` नहीं मिला:**

- zca-cli इंस्टॉल करें और सुनिश्चित करें कि यह Gateway प्रक्रिया के लिए `PATH` पर उपलब्ध है।

**लॉगिन स्थिर नहीं रहता:**

- `openclaw channels status --probe`
- पुनः लॉगिन करें: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
