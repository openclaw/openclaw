---
title: Sandbox CLI
summary: "sandbox कंटेनरों का प्रबंधन करें और प्रभावी sandbox नीति का निरीक्षण करें"
read_when: "आप sandbox कंटेनरों का प्रबंधन कर रहे हैं या sandbox/टूल-नीति व्यवहार का डिबग कर रहे हैं।"
status: active
---

# Sandbox CLI

अलग-थलग एजेंट निष्पादन के लिए Docker-आधारित sandbox कंटेनरों का प्रबंधन करें।

## अवलोकन

6. OpenClaw सुरक्षा के लिए एजेंट्स को आइसोलेटेड Docker कंटेनरों में चला सकता है। 7. `sandbox` कमांड्स इन कंटेनरों को प्रबंधित करने में मदद करते हैं, खासकर अपडेट या कॉन्फ़िगरेशन बदलावों के बाद।

## कमांड्स

### `openclaw sandbox explain`

**प्रभावी** sandbox मोड/स्कोप/वर्कस्पेस एक्सेस, sandbox टूल नीति, और उन्नत गेट्स का निरीक्षण करें (fix-it विन्यास कुंजी पथों के साथ)।

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

सभी sandbox कंटेनरों को उनकी स्थिति और विन्यास के साथ सूचीबद्ध करें।

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**आउटपुट में शामिल है:**

- कंटेनर नाम और स्थिति (चल रहा/रुका हुआ)
- Docker इमेज और क्या वह विन्यास से मेल खाती है
- आयु (निर्माण के बाद से समय)
- निष्क्रिय समय (अंतिम उपयोग के बाद से समय)
- संबद्ध सत्र/एजेंट

### `openclaw sandbox recreate`

अपडेटेड इमेज/विन्यास के साथ पुनः-निर्माण के लिए sandbox कंटेनरों को हटाएँ।

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**विकल्प:**

- `--all`: सभी sandbox कंटेनरों को पुनः-निर्मित करें
- `--session <key>`: किसी विशिष्ट सत्र के लिए कंटेनर पुनः-निर्मित करें
- `--agent <id>`: किसी विशिष्ट एजेंट के लिए कंटेनर पुनः-निर्मित करें
- `--browser`: केवल ब्राउज़र कंटेनरों को पुनः-निर्मित करें
- `--force`: पुष्टि प्रॉम्प्ट को छोड़ें

**महत्वपूर्ण:** एजेंट के अगली बार उपयोग होने पर कंटेनर स्वचालित रूप से पुनः-निर्मित हो जाते हैं।

## उपयोग के मामले

### Docker इमेज अपडेट करने के बाद

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### sandbox विन्यास बदलने के बाद

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### setupCommand बदलने के बाद

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### केवल किसी विशिष्ट एजेंट के लिए

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## यह क्यों आवश्यक है?

**समस्या:** जब आप sandbox Docker इमेज या विन्यास अपडेट करते हैं:

- मौजूदा कंटेनर पुराने सेटिंग्स के साथ चलते रहते हैं
- कंटेनर 24 घंटे की निष्क्रियता के बाद ही हटाए जाते हैं
- नियमित रूप से उपयोग होने वाले एजेंट्स पुराने कंटेनरों को अनिश्चितकाल तक चलाते रहते हैं

8. **Solution:** पुराने कंटेनरों को ज़बरदस्ती हटाने के लिए `openclaw sandbox recreate` का उपयोग करें। They'll be recreated automatically with current settings when next needed.

10. टिप: मैनुअल `docker rm` की बजाय `openclaw sandbox recreate` को प्राथमिकता दें। 11. यह Gateway की कंटेनर नामकरण का उपयोग करता है और scope/session keys बदलने पर होने वाले मिसमैच से बचाता है।

## विन्यास

Sandbox सेटिंग्स `~/.openclaw/openclaw.json` में `agents.defaults.sandbox` के अंतर्गत रहती हैं (प्रति-एजेंट ओवरराइड्स `agents.list[].sandbox` में जाते हैं):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## यह भी देखें

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - sandbox सेटअप की जाँच करें
