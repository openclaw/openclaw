---
summary: "Gateway सेवा, जीवनचक्र और संचालन के लिए रनबुक"
read_when:
  - Gateway प्रक्रिया चलाते या डीबग करते समय
title: "Gateway रनबुक"
---

# Gateway सेवा रनबुक

अंतिम अपडेट: 2025-12-09

## यह क्या है

- हमेशा चालू रहने वाली प्रक्रिया जो एकल Baileys/Telegram कनेक्शन और नियंत्रण/इवेंट प्लेन की मालिक है।
- लीगेसी `gateway` कमांड को प्रतिस्थापित करता है। CLI एंट्री पॉइंट: `openclaw gateway`।
- रोके जाने तक चलती रहती है; घातक त्रुटियों पर non-zero के साथ बाहर निकलती है ताकि सुपरवाइज़र इसे पुनः आरंभ करे।

## कैसे चलाएँ (लोकल)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- कॉन्फ़िग हॉट रीलोड `~/.openclaw/openclaw.json` (या `OPENCLAW_CONFIG_PATH`) पर नज़र रखता है।
  - डिफ़ॉल्ट मोड: `gateway.reload.mode="hybrid"` (सुरक्षित बदलावों को हॉट-अप्लाई, महत्वपूर्ण पर रीस्टार्ट)।
  - हॉट रीलोड आवश्यकता होने पर **SIGUSR1** के माध्यम से इन-प्रोसेस रीस्टार्ट का उपयोग करता है।
  - `gateway.reload.mode="off"` के साथ अक्षम करें।
- WebSocket कंट्रोल प्लेन को `127.0.0.1:<port>` (डिफ़ॉल्ट 18789) पर बाइंड करता है।
- वही पोर्ट HTTP (कंट्रोल UI, हुक्स, A2UI) भी सर्व करता है। सिंगल-पोर्ट मल्टीप्लेक्स।
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api)।
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api)।
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api)।
- डिफ़ॉल्ट रूप से `canvasHost.port` (डिफ़ॉल्ट `18793`) पर Canvas फ़ाइल सर्वर शुरू करता है, जो `~/.openclaw/workspace/canvas` से `http://<gateway-host>:18793/__openclaw__/canvas/` सर्व करता है। `canvasHost.enabled=false` या `OPENCLAW_SKIP_CANVAS_HOST=1` के साथ अक्षम करें।
- stdout पर लॉग करता है; इसे जीवित रखने और लॉग रोटेट करने के लिए launchd/systemd का उपयोग करें।
- समस्या-निवारण के समय लॉग फ़ाइल से stdio में डीबग लॉगिंग (हैंडशेक, req/res, इवेंट्स) मिरर करने के लिए `--verbose` पास करें।
- `--force` चुने गए पोर्ट पर लिसनर्स खोजने के लिए `lsof` का उपयोग करता है, SIGTERM भेजता है, जो मारा उसे लॉग करता है, फिर Gateway शुरू करता है (`lsof` गायब होने पर तेज़ी से विफल होता है)।
- यदि आप किसी सुपरवाइज़र (launchd/systemd/mac ऐप चाइल्ड-प्रोसेस मोड) के अंतर्गत चलाते हैं, तो stop/restart आमतौर पर **SIGTERM** भेजता है; पुराने बिल्ड्स इसे `pnpm` `ELIFECYCLE` एग्ज़िट कोड **143** (SIGTERM) के रूप में दिखा सकते हैं, जो सामान्य शटडाउन है, क्रैश नहीं।
- **SIGUSR1** अधिकृत होने पर इन-प्रोसेस रीस्टार्ट ट्रिगर करता है (gateway टूल/कॉन्फ़िग अप्लाई/अपडेट, या मैनुअल रीस्टार्ट के लिए `commands.restart` सक्षम करें)।
- डिफ़ॉल्ट रूप से Gateway auth आवश्यक है: `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) या `gateway.auth.password` सेट करें। Tailscale Serve identity का उपयोग न करने पर क्लाइंट्स को `connect.params.auth.token/password` भेजना होगा।
- विज़ार्ड अब loopback पर भी डिफ़ॉल्ट रूप से एक टोकन जनरेट करता है।
- पोर्ट प्राथमिकता: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > डिफ़ॉल्ट `18789`।

## रिमोट एक्सेस

- Tailscale/VPN वरीय; अन्यथा SSH टनल:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- इसके बाद क्लाइंट्स टनल के माध्यम से `ws://127.0.0.1:18789` से कनेक्ट करते हैं।

- यदि टोकन कॉन्फ़िगर है, तो क्लाइंट्स को टनल के ऊपर भी `connect.params.auth.token` में इसे शामिल करना होगा।

## कई Gateway (एक ही होस्ट)

आमतौर पर अनावश्यक: एक Gateway कई मैसेजिंग चैनल्स और एजेंट्स को सर्व कर सकता है। एक से अधिक Gateways का उपयोग केवल रिडंडेंसी या कड़े आइसोलेशन (उदा: rescue bot) के लिए करें।

यदि आप स्टेट + कॉन्फ़िग को अलग रखते हैं और यूनिक पोर्ट्स का उपयोग करते हैं तो समर्थित है। पूर्ण गाइड: [Multiple gateways](/gateway/multiple-gateways)।

सेवा नाम प्रोफ़ाइल-अवेयर होते हैं:

- macOS: `bot.molt.<profile>`(legacy `com.openclaw.*` अभी भी मौजूद हो सकता है)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

इंस्टॉल मेटाडेटा सेवा कॉन्फ़िग में एम्बेडेड होता है:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot पैटर्न: अपने स्वयं के प्रोफ़ाइल, स्टेट डायरेक्टरी, वर्कस्पेस और बेस पोर्ट स्पेसिंग के साथ एक दूसरा Gateway आइसोलेटेड रखें। पूर्ण गाइड: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide)।

### Dev प्रोफ़ाइल (`--dev`)

फ़ास्ट पाथ: प्राथमिक सेटअप को छुए बिना पूरी तरह आइसोलेटेड dev इंस्टेंस (कॉन्फ़िग/स्टेट/वर्कस्पेस) चलाएँ।

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

डिफ़ॉल्ट्स (env/flags/config के माध्यम से ओवरराइड किए जा सकते हैं):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- ब्राउज़र कंट्रोल सेवा पोर्ट = `19003` (व्युत्पन्न: `gateway.port+2`, केवल loopback)
- `canvasHost.port=19005` (व्युत्पन्न: `gateway.port+4`)
- `agents.defaults.workspace` का डिफ़ॉल्ट `~/.openclaw/workspace-dev` बन जाता है जब आप `--dev` के तहत `setup`/`onboard` चलाते हैं।

व्युत्पन्न पोर्ट्स (रूल्स ऑफ़ थम्ब):

- बेस पोर्ट = `gateway.port` (या `OPENCLAW_GATEWAY_PORT` / `--port`)
- ब्राउज़र कंट्रोल सेवा पोर्ट = बेस + 2 (केवल loopback)
- `canvasHost.port = base + 4` (या `OPENCLAW_CANVAS_HOST_PORT` / कॉन्फ़िग ओवरराइड)
- ब्राउज़र प्रोफ़ाइल CDP पोर्ट्स `browser.controlPort + 9 .. + 108` से ऑटो-अलॉकेट होते हैं (प्रोफ़ाइल प्रति स्थायी)।

प्रति-इंस्टेंस चेकलिस्ट:

- यूनिक `gateway.port`
- यूनिक `OPENCLAW_CONFIG_PATH`
- यूनिक `OPENCLAW_STATE_DIR`
- यूनिक `agents.defaults.workspace`
- अलग WhatsApp नंबर (यदि WA का उपयोग कर रहे हों)

प्रोफ़ाइल के अनुसार सेवा इंस्टॉल:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

उदाहरण:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## प्रोटोकॉल (ऑपरेटर दृश्य)

- पूर्ण दस्तावेज़: [Gateway protocol](/gateway/protocol) और [Bridge protocol (legacy)](/gateway/bridge-protocol)।
- क्लाइंट से अनिवार्य पहला फ़्रेम: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? 41. } }`. संरचित प्रेज़ेन्स एंट्रीज़: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? 43. }` (WS क्लाइंट्स के लिए, `instanceId` `connect.client.instanceId` से आता है)।
- Gateway `res {type:"res", id, ok:true, payload:hello-ok }` का उत्तर देता है (या त्रुटि के साथ `ok:false`, फिर बंद करता है)।
- हैंडशेक के बाद:
  - अनुरोध: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - इवेंट्स: `{type:"event", event, payload, seq?, stateVersion?}`
- `node.invoke` — किसी नोड पर कमांड इनवोक करें (उदा. `canvas.*`, `camera.*`)। `shutdown` — Gateway बाहर निकल रहा है; payload में `reason` और वैकल्पिक `restartExpectedMs` शामिल होते हैं।
- `agent` प्रतिक्रियाएँ दो-चरणीय होती हैं: पहले `res` ack `{runId,status:"accepted"}`, फिर रन पूरा होने के बाद अंतिम `res` `{runId,status:"ok"|"error",summary}`; स्ट्रीम्ड आउटपुट `event:"agent"` के रूप में आता है।

## मेथड्स (प्रारंभिक सेट)

- `health` — पूर्ण हेल्थ स्नैपशॉट (आकार `openclaw health --json` जैसा)।
- `status` — संक्षिप्त सारांश।
- `system-presence` — वर्तमान presence सूची।
- `system-event` — presence/सिस्टम नोट पोस्ट करें (संरचित)।
- `send` — सक्रिय चैनल(ों) के माध्यम से संदेश भेजें।
- `agent` — एजेंट टर्न चलाएँ (इसी कनेक्शन पर इवेंट्स स्ट्रीम करता है)।
- `node.list` — पेयर्ड + वर्तमान में जुड़े नोड्स सूचीबद्ध करें (इसमें `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, और विज्ञापित `commands` शामिल हैं)।
- `node.describe` — किसी नोड का वर्णन करें (क्षमताएँ + समर्थित `node.invoke` कमांड्स; पेयर्ड नोड्स और वर्तमान में जुड़े अनपेयर्ड नोड्स दोनों के लिए काम करता है)।
- क्लाइंट्स को पुनः कनेक्ट करना चाहिए।
- `node.pair.*` — पेयरिंग जीवनचक्र (`request`, `list`, `approve`, `reject`, `verify`)।

यह भी देखें: presence कैसे उत्पन्न/डीड्यूप होती है और स्थिर `client.instanceId` क्यों महत्वपूर्ण है—इसके लिए [Presence](/concepts/presence)।

## इवेंट्स

- `agent` — एजेंट रन से स्ट्रीम्ड टूल/आउटपुट इवेंट्स (seq-टैग्ड)।
- `presence` — presence अपडेट्स (stateVersion के साथ डेल्टा) सभी जुड़े क्लाइंट्स को पुश किए जाते हैं।
- `tick` — लिवनेस की पुष्टि के लिए आवधिक keepalive/no-op।
- एरर्स `{ code, message, details?, retryable?, retryAfterMs? 48. }` का उपयोग करते हैं। इवेंट्स रीप्ले नहीं किए जाते।

## WebChat एकीकरण

- WebChat एक नेटिव SwiftUI UI है जो इतिहास, भेजने, abort और इवेंट्स के लिए सीधे Gateway WebSocket से बात करता है।
- रिमोट उपयोग उसी SSH/Tailscale टनल से होता है; यदि gateway टोकन कॉन्फ़िगर है, तो क्लाइंट `connect` के दौरान इसे शामिल करता है।
- macOS ऐप एकल WS (शेयर्ड कनेक्शन) के माध्यम से कनेक्ट होता है; यह प्रारंभिक स्नैपशॉट से presence हाइड्रेट करता है और UI अपडेट करने के लिए `presence` इवेंट्स सुनता है।

## टाइपिंग और वैलिडेशन

- सर्वर हर इनबाउंड फ़्रेम को प्रोटोकॉल परिभाषाओं से उत्सर्जित JSON Schema के विरुद्ध AJV से वैलिडेट करता है।
- क्लाइंट्स (TS/Swift) जनरेटेड टाइप्स का उपभोग करते हैं (TS सीधे; Swift रिपॉज़िटरी के जनरेटर के माध्यम से)।
- प्रोटोकॉल परिभाषाएँ सत्य का स्रोत हैं; स्कीमा/मॉडल्स पुनः जनरेट करें:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## कनेक्शन स्नैपशॉट

- `hello-ok` में एक `snapshot` शामिल होता है, जिसमें `presence`, `health`, `stateVersion`, और `uptimeMs` के साथ `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` भी होता है ताकि क्लाइंट्स अतिरिक्त अनुरोधों के बिना तुरंत रेंडर कर सकें।
- `health`/`system-presence` मैनुअल रिफ़्रेश के लिए उपलब्ध रहते हैं, लेकिन कनेक्ट समय पर आवश्यक नहीं हैं।

## त्रुटि कोड (res.error shape)

- क्लाइंट्स seq गैप्स का पता लगाते हैं और आगे बढ़ने से पहले रिफ़्रेश (`health` + `system-presence`) करना चाहिए। }\`.
- मानक कोड:
  - `NOT_LINKED` — WhatsApp प्रमाणीकृत नहीं है।
  - `AGENT_TIMEOUT` — एजेंट ने कॉन्फ़िगर की गई समय-सीमा के भीतर प्रतिक्रिया नहीं दी।
  - `INVALID_REQUEST` — स्कीमा/पैरामीटर वैलिडेशन विफल।
  - `UNAVAILABLE` — Gateway बंद हो रहा है या कोई निर्भरता उपलब्ध नहीं है।

## Keepalive व्यवहार

- `tick` इवेंट्स (या WS ping/pong) आवधिक रूप से उत्सर्जित होते हैं ताकि ट्रैफ़िक न होने पर भी क्लाइंट्स जान सकें कि Gateway जीवित है।
- send/agent acknowledgements अलग प्रतिक्रियाएँ रहती हैं; sends के लिए ticks का दुरुपयोग न करें।

## रीप्ले / गैप्स

- Events are not replayed. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. 1. WebChat और macOS क्लाइंट अब गैप होने पर अपने-आप रीफ़्रेश हो जाते हैं।

## सुपरविज़न (macOS उदाहरण)

- सेवा को जीवित रखने के लिए launchd का उपयोग करें:
  - Program: `openclaw` का पाथ
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: फ़ाइल पाथ्स या `syslog`
- विफलता पर launchd पुनः आरंभ करता है; घातक मिसकॉनफ़िग को बाहर निकलते रहना चाहिए ताकि ऑपरेटर नोटिस करे।
- LaunchAgents प्रति-यूज़र होते हैं और लॉग-इन सत्र की आवश्यकता होती है; हेडलेस सेटअप्स के लिए कस्टम LaunchDaemon का उपयोग करें (शिप नहीं किया गया)।
  - 2. `openclaw gateway install` `~/Library/LaunchAgents/bot.molt.gateway.plist` लिखता है
       (या `bot.molt.<profile>`3. .plist`; पुराना `com.openclaw.\*\` साफ़ कर दिया जाता है)।
  - `openclaw doctor` LaunchAgent कॉन्फ़िग का ऑडिट करता है और इसे वर्तमान डिफ़ॉल्ट्स पर अपडेट कर सकता है।

## Gateway सेवा प्रबंधन (CLI)

इंस्टॉल/स्टार्ट/स्टॉप/रीस्टार्ट/स्टेटस के लिए Gateway CLI का उपयोग करें:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

नोट्स:

- `gateway status` डिफ़ॉल्ट रूप से सेवा के रेज़ॉल्व्ड पोर्ट/कॉन्फ़िग का उपयोग करके Gateway RPC को प्रोब करता है (`--url` से ओवरराइड करें)।
- `gateway status --deep` सिस्टम-स्तरीय स्कैन (LaunchDaemons/system units) जोड़ता है।
- `gateway status --no-probe` RPC प्रोब को स्किप करता है (नेटवर्किंग डाउन होने पर उपयोगी)।
- `gateway status --json` स्क्रिप्ट्स के लिए स्थिर है।
- `gateway status` **supervisor runtime** (launchd/systemd चल रहा) को **RPC reachability** (WS कनेक्ट + स्टेटस RPC) से अलग रिपोर्ट करता है।
- `gateway status` “localhost बनाम LAN bind” भ्रम और प्रोफ़ाइल मिसमैच से बचने के लिए कॉन्फ़िग पाथ + प्रोब टार्गेट प्रिंट करता है।
- `gateway status` सेवा चलती दिखने पर भी पोर्ट बंद होने की स्थिति में अंतिम gateway त्रुटि पंक्ति शामिल करता है।
- `logs` RPC के माध्यम से Gateway फ़ाइल लॉग को टेल करता है (मैनुअल `tail`/`grep` की आवश्यकता नहीं)।
- 4. यदि अन्य gateway-जैसी सेवाएँ पाई जाती हैं, तो CLI चेतावनी देता है, जब तक कि वे OpenClaw प्रोफ़ाइल सेवाएँ न हों।
  5. अधिकांश सेटअप के लिए हम अब भी **प्रति मशीन एक gateway** की सिफ़ारिश करते हैं; redundancy या rescue bot के लिए isolated profiles/ports का उपयोग करें। 6. देखें [Multiple gateways](/gateway/multiple-gateways)।
  - क्लीनअप: `openclaw gateway uninstall` (वर्तमान सेवा) और `openclaw doctor` (लीगेसी माइग्रेशन)।
- `gateway install` पहले से इंस्टॉल होने पर no-op है; पुनः इंस्टॉल के लिए `openclaw gateway install --force` का उपयोग करें (प्रोफ़ाइल/env/पाथ परिवर्तन)।

बंडल्ड mac ऐप:

- 7. OpenClaw.app एक Node-आधारित gateway relay को बंडल कर सकता है और per-user LaunchAgent इंस्टॉल कर सकता है जिसका लेबल
     `bot.molt.gateway` होता है (या `bot.molt.<profile>`8. `; पुराने `com.openclaw.\*\` लेबल भी साफ़-सुथरे ढंग से unload हो जाते हैं)।
- इसे साफ़-साफ़ रोकने के लिए `openclaw gateway stop` (या `launchctl bootout gui/$UID/bot.molt.gateway`) का उपयोग करें।
- पुनः आरंभ के लिए `openclaw gateway restart` (या `launchctl kickstart -k gui/$UID/bot.molt.gateway`) का उपयोग करें।
  - `launchctl` केवल तभी काम करता है जब LaunchAgent इंस्टॉल हो; अन्यथा पहले `openclaw gateway install` का उपयोग करें।
  - 9. नामित प्रोफ़ाइल चलाते समय लेबल को `bot.molt.<profile>` से बदलें।10. \` जब running a named profile।

## सुपरविज़न (systemd यूज़र यूनिट)

11. OpenClaw Linux/WSL2 पर डिफ़ॉल्ट रूप से एक **systemd user service** इंस्टॉल करता है। 12. हम
    single-user मशीनों के लिए user services की सिफ़ारिश करते हैं (सरल env, per-user कॉन्फ़िग)।
12. multi-user या हमेशा-चालू सर्वरों के लिए **system service** का उपयोग करें (linger की आवश्यकता नहीं, साझा supervision)।

14. `openclaw gateway install` user unit लिखता है। 15. `openclaw doctor` unit का ऑडिट करता है
    और इसे वर्तमान अनुशंसित डिफ़ॉल्ट्स से मेल कराने के लिए अपडेट कर सकता है।

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` बनाएँ:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Lingering सक्षम करें (आवश्यक ताकि यूज़र सेवा लॉगआउट/आइडल के बाद भी जीवित रहे):

```
sudo loginctl enable-linger youruser
```

16. Onboarding इसे Linux/WSL2 पर चलाता है (sudo के लिए पूछ सकता है; `/var/lib/systemd/linger` लिखता है)।
17. फिर सेवा सक्षम करें:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

18. **Alternative (system service)** - हमेशा-चालू या multi-user सर्वरों के लिए, आप user unit के बजाय systemd **system** unit इंस्टॉल कर सकते हैं (linger की आवश्यकता नहीं)।
19. `/etc/systemd/system/openclaw-gateway[-<profile>].service` बनाएँ (ऊपर दिए गए unit की कॉपी करें,
    `WantedBy=multi-user.target` पर स्विच करें, `User=` + `WorkingDirectory=` सेट करें), फिर:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows इंस्टॉलेशन्स को **WSL2** का उपयोग करना चाहिए और ऊपर दिए गए Linux systemd अनुभाग का पालन करना चाहिए।

## ऑपरेशनल चेक्स

- Liveness: WS खोलें और `req:connect` भेजें → `res` की अपेक्षा करें जिसमें `payload.type="hello-ok"` (स्नैपशॉट के साथ) हो।
- Readiness: `health` कॉल करें → `ok: true` और `linkChannel` में लिंक्ड चैनल की अपेक्षा करें (जहाँ लागू हो)।
- Debug: `tick` और `presence` इवेंट्स को सब्सक्राइब करें; सुनिश्चित करें कि `status` लिंक्ड/ऑथ आयु दिखाता है; presence एंट्रीज़ Gateway होस्ट और जुड़े क्लाइंट्स दिखाती हैं।

## सुरक्षा गारंटी

- डिफ़ॉल्ट रूप से प्रति होस्ट एक Gateway मानें; यदि कई प्रोफ़ाइल चलाते हैं, तो पोर्ट्स/स्टेट को अलग रखें और सही इंस्टेंस को टार्गेट करें।
- सीधे Baileys कनेक्शनों पर कोई फ़ॉलबैक नहीं; यदि Gateway डाउन है, तो sends तेज़ी से विफल होते हैं।
- non-connect प्रथम फ़्रेम या malformed JSON अस्वीकृत किए जाते हैं और सॉकेट बंद कर दिया जाता है।
- ग्रेसफ़ुल शटडाउन: बंद करने से पहले `shutdown` इवेंट उत्सर्जित करें; क्लाइंट्स को close + reconnect संभालना चाहिए।

## CLI सहायक

- `openclaw gateway health|status` — Gateway WS पर हेल्थ/स्टेटस अनुरोध करें।
- `openclaw message send --target <num> --message "hi" [--media ...]` — Gateway के माध्यम से भेजें (WhatsApp के लिए idempotent)।
- `openclaw agent --message "hi" --to <num>` — एजेंट टर्न चलाएँ (डिफ़ॉल्ट रूप से फ़ाइनल का इंतज़ार करता है)।
- `openclaw gateway call <method> --params '{"k":"v"}'` — डीबगिंग के लिए रॉ मेथड इनवोकर।
- `openclaw gateway stop|restart` — सुपरवाइज़्ड gateway सेवा (launchd/systemd) को stop/restart करें।
- Gateway हेल्पर सबकमांड्स `--url` पर चल रहे gateway को मानते हैं; वे अब स्वतः कोई नया स्पॉन नहीं करते।

## माइग्रेशन मार्गदर्शन

- `openclaw gateway` और लीगेसी TCP कंट्रोल पोर्ट के उपयोग को सेवानिवृत्त करें।
- क्लाइंट्स को WS प्रोटोकॉल बोलने के लिए अपडेट करें जिसमें अनिवार्य connect और संरचित presence शामिल हो।
