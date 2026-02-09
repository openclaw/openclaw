---
summary: "`openclaw devices` के लिए CLI संदर्भ (डिवाइस पेयरिंग + टोकन रोटेशन/रद्द करना)"
read_when:
  - आप डिवाइस पेयरिंग अनुरोधों को स्वीकृत कर रहे हों
  - आपको डिवाइस टोकन को रोटेट या रद्द करना हो
title: "डिवाइस"
---

# `openclaw devices`

डिवाइस पेयरिंग अनुरोधों और डिवाइस-स्कोप्ड टोकनों का प्रबंधन करें।

## Commands

### `openclaw devices list`

लंबित पेयरिंग अनुरोधों और पेयर्ड डिवाइसों की सूची दिखाएँ।

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

किसी लंबित डिवाइस पेयरिंग अनुरोध को स्वीकृत करें।

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

किसी लंबित डिवाइस पेयरिंग अनुरोध को अस्वीकार करें।

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

किसी विशिष्ट भूमिका के लिए डिवाइस टोकन को रोटेट करें (वैकल्पिक रूप से स्कोप अपडेट करते हुए)।

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

किसी विशिष्ट भूमिका के लिए डिवाइस टोकन को रद्द करें।

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway वेब-सॉकेट URL (विन्यस्त होने पर डिफ़ॉल्ट रूप से `gateway.remote.url`)।
- `--token <token>`: Gateway टोकन (यदि आवश्यक हो)।
- `--password <password>`: Gateway पासवर्ड (पासवर्ड प्रमाणीकरण)।
- `--timeout <ms>`: RPC टाइमआउट।
- `--json`: JSON आउटपुट (स्क्रिप्टिंग के लिए अनुशंसित)।

Note: when you set `--url`, the CLI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

## Notes

- Token rotation returns a new token (sensitive). Treat it like a secret.
- इन कमांड्स के लिए `operator.pairing` (या `operator.admin`) स्कोप की आवश्यकता होती है।
