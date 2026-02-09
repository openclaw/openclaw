---
summary: "`openclaw nodes` के लिए CLI संदर्भ (सूची/स्थिति/अनुमोदन/आह्वान, कैमरा/कैनवास/स्क्रीन)"
read_when:
  - आप जोड़े गए नोड्स (कैमरे, स्क्रीन, कैनवास) का प्रबंधन कर रहे हों
  - आपको अनुरोधों को अनुमोदित करना हो या नोड कमांड्स को आह्वान करना हो
title: "नोड्स"
---

# `openclaw nodes`

जोड़े गए नोड्स (डिवाइस) का प्रबंधन करें और नोड क्षमताओं को आह्वान करें।

संबंधित:

- नोड्स अवलोकन: [Nodes](/nodes)
- कैमरा: [Camera nodes](/nodes/camera)
- इमेजेज़: [Image nodes](/nodes/images)

सामान्य विकल्प:

- `--url`, `--token`, `--timeout`, `--json`

## सामान्य कमांड्स

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` prints pending/paired tables. Paired rows include the most recent connect age (Last Connect).
Use `--connected` to only show currently-connected nodes. Use `--last-connected <duration>` to
filter to nodes that connected within a duration (e.g. `24h`, `7d`).

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke फ़्लैग्स:

- `--params <json>`: JSON ऑब्जेक्ट स्ट्रिंग (डिफ़ॉल्ट `{}`)।
- `--invoke-timeout <ms>`: नोड invoke टाइमआउट (डिफ़ॉल्ट `15000`)।
- `--idempotency-key <key>`: वैकल्पिक idempotency कुंजी।

### Exec-शैली डिफ़ॉल्ट्स

`nodes run` मॉडल के exec व्यवहार (डिफ़ॉल्ट्स + अनुमोदन) का प्रतिबिंब है:

- `tools.exec.*` पढ़ता है (साथ में `agents.list[].tools.exec.*` ओवरराइड्स)।
- `system.run` को आह्वान करने से पहले exec अनुमोदन (`exec.approval.request`) का उपयोग करता है।
- जब `tools.exec.node` सेट हो, तो `--node` छोड़ा जा सकता है।
- ऐसे नोड की आवश्यकता होती है जो `system.run` का विज्ञापन करता हो (macOS सहचर ऐप या हेडलेस नोड होस्ट)।

फ़्लैग्स:

- `--cwd <path>`: वर्किंग डायरेक्टरी।
- `--env <key=val>`: env ओवरराइड (दोहराने योग्य)।
- `--command-timeout <ms>`: कमांड टाइमआउट।
- `--invoke-timeout <ms>`: नोड invoke टाइमआउट (डिफ़ॉल्ट `30000`)।
- `--needs-screen-recording`: स्क्रीन रिकॉर्डिंग अनुमति आवश्यक।
- `--raw <command>`: शेल स्ट्रिंग चलाएँ (`/bin/sh -lc` या `cmd.exe /c`)।
- `--agent <id>`: एजेंट-स्कोप्ड अनुमोदन/allowlists (कॉन्फ़िगर किए गए एजेंट पर डिफ़ॉल्ट)।
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: ओवरराइड्स।
