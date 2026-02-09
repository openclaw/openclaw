---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — Gateway को चलाएँ, क्वेरी करें, और खोजें"
read_when:
  - CLI से Gateway चलाते समय (डेव या सर्वर)
  - Gateway प्रमाणीकरण, बाइंड मोड, और कनेक्टिविटी का डिबग करते समय
  - Bonjour के माध्यम से Gateways की खोज (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Gateway, OpenClaw का WebSocket सर्वर है (चैनल, नोड्स, सत्र, हुक्स)।

इस पृष्ठ के सबकमांड `openclaw gateway …` के अंतर्गत आते हैं।

संबंधित दस्तावेज़:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway चलाएँ

एक स्थानीय Gateway प्रक्रिया चलाएँ:

```bash
openclaw gateway
```

फ़ोरग्राउंड उपनाम:

```bash
openclaw gateway run
```

टिप्पणियाँ:

- By default, the Gateway refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` for ad-hoc/dev runs.
- प्रमाणीकरण के बिना loopback से आगे बाइंड करना अवरुद्ध है (सुरक्षा गार्डरेल)।
- `SIGUSR1` अधिकृत होने पर इन-प्रोसेस रीस्टार्ट ट्रिगर करता है ( `commands.restart` सक्षम करें या gateway tool/config apply/update का उपयोग करें)।
- `SIGINT`/`SIGTERM` handlers stop the gateway process, but they don’t restore any custom terminal state. If you wrap the CLI with a TUI or raw-mode input, restore the terminal before exit.

### विकल्प

- `--port <port>`: WebSocket पोर्ट (डिफ़ॉल्ट config/env से आता है; सामान्यतः `18789`)।
- `--bind <loopback|lan|tailnet|auto|custom>`: listener बाइंड मोड।
- `--auth <token|password>`: auth मोड ओवरराइड।
- `--token <token>`: टोकन ओवरराइड (प्रक्रिया के लिए `OPENCLAW_GATEWAY_TOKEN` भी सेट करता है)।
- `--password <password>`: पासवर्ड ओवरराइड (प्रक्रिया के लिए `OPENCLAW_GATEWAY_PASSWORD` भी सेट करता है)।
- `--tailscale <off|serve|funnel>`: Tailscale के माध्यम से Gateway को एक्सपोज़ करें।
- `--tailscale-reset-on-exit`: शटडाउन पर Tailscale serve/funnel विन्यास रीसेट करें।
- `--allow-unconfigured`: config में `gateway.mode=local` के बिना Gateway शुरू करने की अनुमति दें।
- `--dev`: यदि अनुपस्थित हो तो dev config + workspace बनाएँ (BOOTSTRAP.md को छोड़ता है)।
- `--reset`: dev config + credentials + sessions + workspace रीसेट करें ( `--dev` आवश्यक)।
- `--force`: शुरू करने से पहले चयनित पोर्ट पर किसी भी मौजूदा listener को समाप्त करें।
- `--verbose`: विस्तृत लॉग्स।
- `--claude-cli-logs`: कंसोल में केवल claude-cli लॉग्स दिखाएँ (और उसका stdout/stderr सक्षम करें)।
- `--ws-log <auto|full|compact>`: websocket लॉग शैली (डिफ़ॉल्ट `auto`)।
- `--compact`: `--ws-log compact` के लिए उपनाम।
- `--raw-stream`: कच्चे मॉडल स्ट्रीम इवेंट्स को jsonl में लॉग करें।
- `--raw-stream-path <path>`: raw stream jsonl पथ।

## चल रहे Gateway से क्वेरी करें

सभी क्वेरी कमांड WebSocket RPC का उपयोग करते हैं।

आउटपुट मोड:

- डिफ़ॉल्ट: मानव-पठनीय (TTY में रंगीन)।
- `--json`: मशीन-पठनीय JSON (कोई स्टाइलिंग/स्पिनर नहीं)।
- `--no-color` (या `NO_COLOR=1`): मानव लेआउट रखते हुए ANSI अक्षम करें।

साझा विकल्प (जहाँ समर्थित हों):

- `--url <url>`: Gateway WebSocket URL।
- `--token <token>`: Gateway टोकन।
- `--password <password>`: Gateway पासवर्ड।
- `--timeout <ms>`: टाइमआउट/बजट (कमांड के अनुसार भिन्न)।
- `--expect-final`: “final” प्रतिक्रिया की प्रतीक्षा करें (agent कॉल्स)।

Note: when you set `--url`, the CLI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` Gateway सेवा (launchd/systemd/schtasks) के साथ एक वैकल्पिक RPC प्रोब दिखाता है।

```bash
openclaw gateway status
openclaw gateway status --json
```

विकल्प:

- `--url <url>`: प्रोब URL ओवरराइड करें।
- `--token <token>`: प्रोब के लिए टोकन प्रमाणीकरण।
- `--password <password>`: प्रोब के लिए पासवर्ड प्रमाणीकरण।
- `--timeout <ms>`: प्रोब टाइमआउट (डिफ़ॉल्ट `10000`)।
- `--no-probe`: RPC प्रोब छोड़ें (केवल सेवा दृश्य)।
- `--deep`: सिस्टम-स्तरीय सेवाओं को भी स्कैन करें।

### `gateway probe`

`gateway probe` is the “debug everything” command. It always probes:

- आपका कॉन्फ़िगर किया गया रिमोट Gateway (यदि सेट हो), और
- localhost (loopback) **भले ही रिमोट कॉन्फ़िगर हो**।

If multiple gateways are reachable, it prints all of them. Multiple gateways are supported when you use isolated profiles/ports (e.g., a rescue bot), but most installs still run a single gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH के माध्यम से दूरस्थ (Mac ऐप समानता)

macOS ऐप का “Remote over SSH” मोड एक स्थानीय पोर्ट-फ़ॉरवर्ड का उपयोग करता है ताकि रिमोट Gateway (जो केवल loopback पर बाइंड हो सकता है) `ws://127.0.0.1:<port>` पर पहुँच योग्य बन जाए।

CLI समकक्ष:

```bash
openclaw gateway probe --ssh user@gateway-host
```

विकल्प:

- `--ssh <target>`: `user@host` या `user@host:port` (पोर्ट डिफ़ॉल्ट `22`)।
- `--ssh-identity <path>`: identity फ़ाइल।
- `--ssh-auto`: खोजे गए पहले Gateway होस्ट को SSH लक्ष्य के रूप में चुनें (केवल LAN/WAB)।

Config (वैकल्पिक, डिफ़ॉल्ट्स के रूप में उपयोग):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

लो-लेवल RPC सहायक।

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway सेवा प्रबंधित करें

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

टिप्पणियाँ:

- `gateway install` `--port`, `--runtime`, `--token`, `--force`, `--json` का समर्थन करता है।
- लाइफ़साइकल कमांड्स स्क्रिप्टिंग के लिए `--json` स्वीकार करते हैं।

## Gateways खोजें (Bonjour)

`gateway discover` Gateway बीकन्स (`_openclaw-gw._tcp`) के लिए स्कैन करता है।

- मल्टीकास्ट DNS-SD: `local.`
- यूनिकास्ट DNS-SD (Wide-Area Bonjour): एक डोमेन चुनें (उदाहरण: `openclaw.internal.`) और split DNS + एक DNS सर्वर सेट करें; देखें [/gateway/bonjour](/gateway/bonjour)

केवल वे Gateways जिनमें Bonjour discovery सक्षम है (डिफ़ॉल्ट) बीकन का विज्ञापन करते हैं।

Wide-Area discovery रिकॉर्ड्स में (TXT) शामिल हैं:

- `role` (Gateway भूमिका संकेत)
- `transport` (ट्रांसपोर्ट संकेत, जैसे `gateway`)
- `gatewayPort` (WebSocket पोर्ट, सामान्यतः `18789`)
- `sshPort` (SSH पोर्ट; यदि मौजूद न हो तो डिफ़ॉल्ट `22`)
- `tailnetDns` (MagicDNS होस्टनाम, उपलब्ध होने पर)
- `gatewayTls` / `gatewayTlsSha256` (TLS सक्षम + सर्टिफ़िकेट फ़िंगरप्रिंट)
- `cliPath` (रिमोट इंस्टॉलेशन्स के लिए वैकल्पिक संकेत)

### `gateway discover`

```bash
openclaw gateway discover
```

विकल्प:

- `--timeout <ms>`: प्रति-कमांड टाइमआउट (browse/resolve); डिफ़ॉल्ट `2000`।
- `--json`: मशीन-पठनीय आउटपुट (स्टाइलिंग/स्पिनर भी अक्षम करता है)।

उदाहरण:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
