---
summary: "NIP-04 एन्क्रिप्टेड संदेशों के माध्यम से Nostr DM चैनल"
read_when:
  - आप चाहते हैं कि OpenClaw Nostr के माध्यम से DM प्राप्त करे
  - आप विकेंद्रीकृत मैसेजिंग सेट कर रहे हैं
title: "Nostr"
---

# Nostr

**स्थिति:** वैकल्पिक प्लगइन (डिफ़ॉल्ट रूप से अक्षम)।

Nostr सोशल नेटवर्किंग के लिए एक विकेंद्रीकृत प्रोटोकॉल है। यह चैनल OpenClaw को NIP-04 के माध्यम से एन्क्रिप्टेड डायरेक्ट मैसेज (DMs) प्राप्त करने और उनका उत्तर देने में सक्षम बनाता है।

## Install (on demand)

### Onboarding (recommended)

- ऑनबोर्डिंग विज़ार्ड (`openclaw onboard`) और `openclaw channels add` वैकल्पिक चैनल प्लगइन्स सूचीबद्ध करते हैं।
- Nostr चुनने पर ऑन-डिमांड प्लगइन इंस्टॉल करने का संकेत मिलता है।

इंस्टॉल डिफ़ॉल्ट्स:

- **Dev चैनल + git checkout उपलब्ध:** स्थानीय प्लगइन पथ का उपयोग करता है।
- **Stable/Beta:** npm से डाउनलोड करता है।

आप प्रॉम्प्ट में हमेशा इस चयन को ओवरराइड कर सकते हैं।

### Manual install

```bash
openclaw plugins install @openclaw/nostr
```

स्थानीय checkout का उपयोग करें (dev वर्कफ़्लो):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

प्लगइन्स इंस्टॉल या सक्षम करने के बाद Gateway को पुनः प्रारंभ करें।

## Quick setup

1. Nostr की-पेयर जनरेट करें (यदि आवश्यक हो):

```bash
# Using nak
nak key generate
```

2. विन्यास में जोड़ें:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. कुंजी निर्यात करें:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway को पुनः प्रारंभ करें।

## Configuration reference

| Key          | Type                                                         | Default                                     | Description                              |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------- |
| `privateKey` | string                                                       | required                                    | `nsec` या hex फ़ॉर्मैट में निजी कुंजी    |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | रिले URLs (वेब-सॉकेट) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM प्रवेश नीति                           |
| `allowFrom`  | string[] | `[]`                                        | अनुमत प्रेषक pubkeys                     |
| `enabled`    | boolean                                                      | `true`                                      | चैनल सक्षम/अक्षम                         |
| `name`       | string                                                       | -                                           | प्रदर्शित नाम                            |
| `profile`    | object                                                       | -                                           | NIP-01 प्रोफ़ाइल मेटाडेटा                |

## Profile metadata

प्रोफ़ाइल डेटा NIP-01 `kind:0` इवेंट के रूप में प्रकाशित किया जाता है। आप इसे Control UI (Channels -> Nostr -> Profile) से प्रबंधित कर सकते हैं या सीधे कॉन्फ़िग में सेट कर सकते हैं।

उदाहरण:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

नोट्स:

- प्रोफ़ाइल URLs में `https://` का उपयोग होना चाहिए।
- रिले से इम्पोर्ट करने पर फ़ील्ड्स मर्ज होते हैं और स्थानीय ओवरराइड्स सुरक्षित रहते हैं।

## Access control

### DM policies

- **pairing** (डिफ़ॉल्ट): अज्ञात प्रेषकों को एक pairing कोड मिलता है।
- **allowlist**: केवल `allowFrom` में मौजूद pubkeys ही DM कर सकते हैं।
- **open**: सार्वजनिक इनबाउंड DMs (आवश्यकता: `allowFrom: ["*"]`)।
- **disabled**: इनबाउंड DMs को अनदेखा करें।

### Allowlist example

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Key formats

स्वीकृत फ़ॉर्मैट्स:

- **Private key:** `nsec...` या 64-अक्षर hex
- **Pubkeys (`allowFrom`):** `npub...` या hex

## Relays

डिफ़ॉल्ट्स: `relay.damus.io` और `nos.lol`।

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

सुझाव:

- रिडंडेंसी के लिए 2–3 रिले उपयोग करें।
- बहुत अधिक रिले से बचें (लेटेंसी, डुप्लिकेशन)।
- पेड रिले विश्वसनीयता बढ़ा सकते हैं।
- परीक्षण के लिए स्थानीय रिले ठीक हैं (`ws://localhost:7777`)।

## Protocol support

| NIP    | Status    | Description                                    |
| ------ | --------- | ---------------------------------------------- |
| NIP-01 | Supported | बुनियादी इवेंट फ़ॉर्मैट + प्रोफ़ाइल मेटाडेटा   |
| NIP-04 | Supported | एन्क्रिप्टेड DMs (`kind:4`) |
| NIP-17 | Planned   | गिफ़्ट-रैप्ड DMs                               |
| NIP-44 | Planned   | संस्करणयुक्त एन्क्रिप्शन                       |

## Testing

### Local relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Manual test

1. लॉग्स से बॉट pubkey (npub) नोट करें।
2. किसी Nostr क्लाइंट (Damus, Amethyst, आदि) को खोलें।
3. बॉट pubkey को DM भेजें।
4. प्रतिक्रिया सत्यापित करें।

## Troubleshooting

### संदेश प्राप्त नहीं हो रहे

- सुनिश्चित करें कि निजी कुंजी मान्य है।
- जाँचें कि रिले URLs पहुँच योग्य हैं और `wss://` का उपयोग करते हैं (या स्थानीय के लिए `ws://`)।
- पुष्टि करें कि `enabled` `false` नहीं है।
- रिले कनेक्शन त्रुटियों के लिए Gateway लॉग्स देखें।

### प्रतिक्रियाएँ नहीं भेजी जा रहीं

- जाँचें कि रिले लिखने की अनुमति देता है।
- आउटबाउंड कनेक्टिविटी सत्यापित करें।
- रिले रेट लिमिट्स पर नज़र रखें।

### डुप्लिकेट प्रतिक्रियाएँ

- कई रिले उपयोग करने पर अपेक्षित।
- संदेश इवेंट ID द्वारा डीडुप्लिकेट किए जाते हैं; केवल पहली डिलीवरी प्रतिक्रिया ट्रिगर करती है।

## Security

- निजी कुंजियाँ कभी कमिट न करें।
- कुंजियों के लिए पर्यावरण चर का उपयोग करें।
- प्रोडक्शन बॉट्स के लिए `allowlist` पर विचार करें।

## Limitations (MVP)

- केवल डायरेक्ट मैसेज (ग्रुप चैट नहीं)।
- मीडिया अटैचमेंट्स नहीं।
- केवल NIP-04 (NIP-17 गिफ़्ट-रैप योजना में)।
