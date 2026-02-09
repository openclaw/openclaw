---
summary: "Exec टूल का उपयोग, stdin मोड्स, और TTY समर्थन"
read_when:
  - Exec टूल का उपयोग या संशोधन करते समय
  - stdin या TTY व्यवहार का डिबग करते समय
title: "Exec टूल"
---

# Exec टूल

workspace में shell commands चलाएँ। `process` के माध्यम से foreground + background execution का समर्थन करता है।
यदि `process` निषिद्ध है, तो `exec` synchronous रूप से चलता है और `yieldMs`/`background` को अनदेखा करता है।
Background सेशन प्रति एजेंट स्कोप किए जाते हैं; `process` केवल उसी एजेंट के सेशन देखता है।

## Parameters

- `command` (आवश्यक)
- `workdir` (डिफ़ॉल्ट: cwd)
- `env` (कुंजी/मान ओवरराइड्स)
- `yieldMs` (डिफ़ॉल्ट 10000): देरी के बाद स्वतः बैकग्राउंड
- `background` (bool): तुरंत बैकग्राउंड
- `timeout` (सेकंड, डिफ़ॉल्ट 1800): समाप्ति पर kill
- `pty` (bool): उपलब्ध होने पर pseudo-terminal में चलाएँ (केवल TTY CLI, कोडिंग एजेंट, टर्मिनल UI)
- `host` (`sandbox | gateway | node`): कहाँ निष्पादित करना है
- `security` (`deny | allowlist | full`): `gateway`/`node` के लिए प्रवर्तन मोड
- `ask` (`off | on-miss | always`): `gateway`/`node` के लिए अनुमोदन प्रॉम्प्ट
- `node` (string): `host=node` के लिए node id/नाम
- `elevated` (bool): elevated मोड का अनुरोध (Gateway होस्ट); `security=full` केवल तब बाध्य होता है जब elevated का समाधान `full` में होता है

Notes:

- `host` का डिफ़ॉल्ट `sandbox` है।
- sandboxing बंद होने पर `elevated` अनदेखा किया जाता है (exec पहले से ही होस्ट पर चलता है)।
- `gateway`/`node` अनुमोदन `~/.openclaw/exec-approvals.json` द्वारा नियंत्रित होते हैं।
- `node` के लिए एक paired node (companion app या headless node host) आवश्यक है।
- यदि कई nodes उपलब्ध हों, तो एक चुनने के लिए `exec.node` या `tools.exec.node` सेट करें।
- गैर-Windows होस्ट पर, exec सेट होने पर `SHELL` का उपयोग करता है; यदि `SHELL` `fish` है, तो यह fish-असंगत स्क्रिप्ट से बचने के लिए `PATH` से `bash` (या `sh`) को प्राथमिकता देता है, फिर यदि दोनों मौजूद न हों तो `SHELL` पर फ़ॉलबैक करता है।
- होस्ट निष्पादन (`gateway`/`node`) बाइनरी हाइजैकिंग या इंजेक्टेड कोड को रोकने के लिए `env.PATH` और loader ओवरराइड्स (`LD_*`/`DYLD_*`) को अस्वीकार करता है।
- महत्वपूर्ण: sandboxing **डिफ़ॉल्ट रूप से बंद** है। यदि sandboxing बंद है, तो `host=sandbox` सीधे गेटवे होस्ट पर चलता है (कोई कंटेनर नहीं) और **अनुमोदन की आवश्यकता नहीं होती**। अनुमोदन की आवश्यकता के लिए, `host=gateway` के साथ चलाएँ और exec approvals कॉन्फ़िगर करें (या sandboxing सक्षम करें)।

## Config

- `tools.exec.notifyOnExit` (डिफ़ॉल्ट: true): true होने पर, बैकग्राउंड किए गए exec सत्र एक सिस्टम इवेंट कतारबद्ध करते हैं और बाहर निकलने पर heartbeat का अनुरोध करते हैं।
- `tools.exec.approvalRunningNoticeMs` (डिफ़ॉल्ट: 10000): जब कोई अनुमोदन-गेटेड exec इससे अधिक समय तक चलता है, तो एकल “running” सूचना उत्सर्जित करें (0 अक्षम करता है)।
- `tools.exec.host` (डिफ़ॉल्ट: `sandbox`)
- `tools.exec.security` (डिफ़ॉल्ट: sandbox के लिए `deny`, unset होने पर gateway + node के लिए `allowlist`)
- `tools.exec.ask` (डिफ़ॉल्ट: `on-miss`)
- `tools.exec.node` (डिफ़ॉल्ट: unset)
- `tools.exec.pathPrepend`: exec रन के लिए `PATH` में prepend करने हेतु डायरेक्टरी की सूची।
- `tools.exec.safeBins`: stdin-only सुरक्षित बाइनरीज़ जो बिना स्पष्ट allowlist प्रविष्टियों के चल सकती हैं।

Example:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH handling

- `host=gateway`: आपके login-shell `PATH` को exec वातावरण में मर्ज करता है। Host execution के लिए `env.PATH` overrides अस्वीकार कर दिए जाते हैं। डेमन स्वयं अभी भी न्यूनतम `PATH` के साथ चलता है:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: कंटेनर के भीतर `sh -lc` (login shell) चलाता है, इसलिए `/etc/profile` `PATH` को रीसेट कर सकता है।
  OpenClaw प्रोफ़ाइल sourcing के बाद एक आंतरिक env var के माध्यम से `env.PATH` को prepend करता है (कोई shell interpolation नहीं); `tools.exec.pathPrepend` यहाँ भी लागू होता है।
- `host=node`: केवल वे non-blocked env overrides जो आप पास करते हैं, नोड को भेजे जाते हैं। Host execution के लिए `env.PATH` overrides अस्वीकार कर दिए जाते हैं। Headless node hosts `PATH` को केवल तब स्वीकार करते हैं जब वह node host `PATH` को prepend करता है (कोई replacement नहीं)। macOS nodes `PATH` overrides को पूरी तरह हटा देते हैं।

प्रति-एजेंट node binding (config में agent list index का उपयोग करें):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: Nodes टैब में इन्हीं सेटिंग्स के लिए एक छोटा “Exec node binding” पैनल शामिल है।

## Session overrides (`/exec`)

`/exec` का उपयोग **per-session** डिफ़ॉल्ट्स सेट करने के लिए करें: `host`, `security`, `ask`, और `node`।
वर्तमान मान दिखाने के लिए बिना किसी arguments के `/exec` भेजें।

Example:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Authorization model

`/exec` केवल **authorized senders** के लिए मान्य होता है (channel allowlists/pairing plus `commands.useAccessGroups`)।
यह केवल **session state** अपडेट करता है और कॉन्फ़िग नहीं लिखता। exec को पूरी तरह अक्षम करने के लिए, tool policy के माध्यम से इसे deny करें (`tools.deny: ["exec"]` या per-agent)। जब तक आप स्पष्ट रूप से `security=full` और `ask=off` सेट नहीं करते, host approvals लागू रहते हैं।

## Exec approvals (companion app / node host)

Sandboxed agents गेटवे या नोड होस्ट पर `exec` चलने से पहले प्रति-अनुरोध अनुमोदन की आवश्यकता कर सकते हैं।
नीति, allowlist, और UI फ्लो के लिए [Exec approvals](/tools/exec-approvals) देखें।

जब अनुमोदन आवश्यक होते हैं, तो exec टूल तुरंत `status: "approval-pending"` और एक approval id के साथ लौट आता है। एक बार स्वीकृत (या अस्वीकृत / टाइमआउट) होने पर, Gateway सिस्टम इवेंट्स (`Exec finished` / `Exec denied`) उत्सर्जित करता है। यदि कमांड `tools.exec.approvalRunningNoticeMs` के बाद भी चल रही है, तो एकल `Exec running` सूचना उत्सर्जित की जाती है।

## Allowlist + safe bins

Allowlist enforcement केवल **resolved binary paths** से मेल खाता है (basename मैच नहीं)। जब `security=allowlist` हो, तो shell commands केवल तभी auto-allowed होते हैं जब हर pipeline segment allowlisted हो या एक safe bin हो। Allowlist मोड में chaining (`;`, `&&`, `||`) और redirections अस्वीकार कर दिए जाते हैं।

## Examples

Foreground:

```json
{ "tool": "exec", "command": "ls -la" }
```

Background + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Send keys (tmux-शैली):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Submit (केवल CR भेजें):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (डिफ़ॉल्ट रूप से bracketed):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (experimental)

`apply_patch` structured multi-file edits के लिए `exec` का एक subtool है।
इसे स्पष्ट रूप से सक्षम करें:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notes:

- केवल OpenAI/OpenAI Codex मॉडलों के लिए उपलब्ध।
- टूल policy अभी भी लागू होती है; `allow: ["exec"]` अंतर्निहित रूप से `apply_patch` की अनुमति देता है।
- Config `tools.exec.applyPatch` के अंतर्गत रहता है।
