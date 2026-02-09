---
summary: "CLI के लिए `openclaw approvals` का संदर्भ (Gateway या नोड होस्ट के लिए exec अनुमोदन)"
read_when:
  - आप CLI से exec अनुमोदनों को संपादित करना चाहते हैं
  - आपको Gateway या नोड होस्ट पर अनुमति सूचियों का प्रबंधन करना है
title: "अनुमोदन"
---

# `openclaw approvals`

**स्थानीय होस्ट**, **गेटवे होस्ट**, या **नोड होस्ट** के लिए exec अनुमोदनों का प्रबंधन करें।
डिफ़ॉल्ट रूप से, कमांड डिस्क पर स्थानीय अनुमोदन फ़ाइल को लक्षित करते हैं। गेटवे को लक्षित करने के लिए `--gateway`, या किसी विशिष्ट नोड को लक्षित करने के लिए `--node` का उपयोग करें।

संबंधित:

- Exec अनुमोदन: [Exec approvals](/tools/exec-approvals)
- नोड्स: [Nodes](/nodes)

## सामान्य कमांड

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## फ़ाइल से अनुमोदन बदलें

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## अनुमति सूची सहायक

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## नोट्स

- `--node` वही रिज़ॉल्वर उपयोग करता है जो `openclaw nodes` करता है (id, name, ip, या id प्रीफ़िक्स)।
- `--agent` का डिफ़ॉल्ट मान `"*"` है, जो सभी एजेंटों पर लागू होता है।
- नोड होस्ट को `system.execApprovals.get/set` का विज्ञापन करना आवश्यक है (macOS ऐप या हेडलेस नोड होस्ट)।
- अनुमोदन फ़ाइलें प्रत्येक होस्ट के लिए `~/.openclaw/exec-approvals.json` पर संग्रहीत होती हैं।
