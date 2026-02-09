---
summary: "`openclaw config` के लिए CLI संदर्भ (config मान प्राप्त/सेट/अनसेट करें)"
read_when:
  - आप config को गैर‑इंटरैक्टिव रूप से पढ़ना या संपादित करना चाहते हैं
title: "config"
---

# `openclaw config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `openclaw configure`).

## Examples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Paths

पथ डॉट या ब्रैकेट नोटेशन का उपयोग करते हैं:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

किसी विशिष्ट एजेंट को लक्षित करने के लिए एजेंट सूची इंडेक्स का उपयोग करें:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

संपादन के बाद Gateway को पुनः आरंभ करें।
