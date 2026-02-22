# OpenClaw Threat Model v1.0

## MITRE ATLAS Framework

**Version:** 1.0-draft
**Last Updated:** 2026-02-04
**Methodology:** MITRE ATLAS + Data Flow Diagrams
**Framework:** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems)

### Framework Attribution

This threat model is built on [MITRE ATLAS](https://atlas.mitre.org/), the industry-standard framework for documenting adversarial threats to AI/ML systems. ATLAS is maintained by [MITRE](https://www.mitre.org/) in collaboration with the AI security community.

**Key ATLAS Resources:**

- [ATLAS Techniques](https://atlas.mitre.org/techniques/)
- [ATLAS Tactics](https://atlas.mitre.org/tactics/)
- [ATLAS Case Studies](https://atlas.mitre.org/studies/)
- [ATLAS GitHub](https://github.com/mitre-atlas/atlas-data)
- [Contributing to ATLAS](https://atlas.mitre.org/resources/contribute)

### Contributing to This Threat Model

This is a living document maintained by the OpenClaw community. See [CONTRIBUTING-THREAT-MODEL.md](./CONTRIBUTING-THREAT-MODEL.md) for guidelines on contributing:

- Reporting new threats
- Updating existing threats
- Proposing attack chains
- Suggesting mitigations

---

## 1. Introduction

### 1.1 Purpose

This threat model documents adversarial threats to the OpenClaw AI agent platform and ClawHub skill marketplace, using the MITRE ATLAS framework designed specifically for AI/ML systems.

### 1.2 Scope

| Component              | Included | မှတ်ချက်များ                                     |
| ---------------------- | -------- | ------------------------------------------------ |
| OpenClaw Agent Runtime | Yes      | Core agent execution, tool calls, sessions       |
| Gateway                | Yes      | Authentication, routing, channel integration     |
| Channel Integrations   | Yes      | WhatsApp, Telegram, Discord, Signal, Slack, etc. |
| ClawHub Marketplace    | Yes      | Skill publishing, moderation, distribution       |
| MCP Servers            | Yes      | External tool providers                          |
| User Devices           | Partial  | Mobile apps, desktop clients                     |

### 1.3 Out of Scope

Nothing is explicitly out of scope for this threat model.

---

## 4. 2. System Architecture

### 2.1 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                    UNTRUSTED ZONE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  ...         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 1: Channel Access                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      GATEWAY                              │   │
│  │  • Device Pairing (30s grace period)                      │   │
│  │  • AllowFrom / AllowList validation                       │   │
│  │  • Token/Password/Tailscale auth                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 2: Session Isolation              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   AGENT SESSIONS                          │   │
│  │  • Session key = agent:channel:peer                       │   │
│  │  • Tool policies per agent                                │   │
│  │  • Transcript logging                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 3: Tool Execution                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  EXECUTION SANDBOX                        │   │
│  │  • Docker sandbox OR Host (exec-approvals)                │   │
│  │  • Node remote execution                                  │   │
│  │  • SSRF protection (DNS pinning + IP blocking)            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 4: External Content               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              FETCHED URLs / EMAILS / WEBHOOKS             │   │
│  │  • External content wrapping (XML tags)                   │   │
│  │  • Security notice injection                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 5: Supply Chain                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      CLAWHUB                              │   │
│  │  • Skill publishing (semver, SKILL.md required)           │   │
│  │  • Pattern-based moderation flags                         │   │
│  │  • VirusTotal scanning (coming soon)                      │   │
│  │  • GitHub account age verification                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flows

| Flow | Source  | Destination | Data               | Protection           |
| ---- | ------- | ----------- | ------------------ | -------------------- |
| F1   | Channel | Gateway     | User messages      | TLS, AllowFrom       |
| F2   | Gateway | Agent       | Routed messages    | Session isolation    |
| F3   | Agent   | ကိရိယာများ  | Tool invocations   | Policy enforcement   |
| F4   | Agent   | External    | web_fetch requests | SSRF blocking        |
| F5   | ClawHub | Agent       | Skill code         | Moderation, scanning |
| F6   | Agent   | Channel     | Responses          | Output filtering     |

---

## 8. 3. Threat Analysis by ATLAS Tactic

### 3.1 Reconnaissance (AML.TA0002)

#### T-RECON-001: Agent Endpoint Discovery

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                          |
| **Description**         | Attacker scans for exposed OpenClaw gateway endpoints                |
| **Attack Vector**       | Network scanning, shodan queries, DNS enumeration                    |
| **Affected Components** | Gateway, exposed API endpoints                                       |
| **Current Mitigations** | Tailscale auth option, bind to loopback by default                   |
| **Residual Risk**       | Medium - Public gateways discoverable                                |
| **Recommendations**     | Document secure deployment, add rate limiting on discovery endpoints |

#### T-RECON-002: Channel Integration Probing

| Attribute                                   | Value                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| **ATLAS ID**                                | AML.T0006 - Active Scanning                                               |
| **Description**                             | Attacker probes messaging channels to identify AI-managed accounts        |
| **Attack Vector**                           | 1. စမ်းသပ် မက်ဆေ့ချ်များ ပို့ခြင်း၊ တုံ့ပြန်ပုံစံများကို စောင့်ကြည့်ခြင်း |
| 2. **ထိခိုက်သက်ရောက်သည့် အစိတ်အပိုင်းများ** | 3. ချန်နယ် ပေါင်းစည်းမှုများ အားလုံး                                      |
| **Current Mitigations**                     | 5. အထူးသဖြင့် မရှိပါ                                                      |
| 6. **ကျန်ရှိသည့် အန္တရာယ်**                 | Low - Limited value from discovery alone                                  |
| 8. **အကြံပြုချက်များ**                      | 9. တုံ့ပြန်ချိန်ကို ကျပန်းပြောင်းလဲခြင်းကို စဉ်းစားပါ                     |

---

### 10. 3.2 အစပိုင်း ဝင်ရောက်ခွင့် (AML.TA0004)

#### 11. T-ACCESS-001: Pairing Code ကြားဖြတ်ရယူခြင်း

| 12. အင်္ဂါရပ်                                | Value                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| 13. **ATLAS ID**                             | 14. AML.T0040 - AI မော်ဒယ် အနုမာန် API ဝင်ရောက်ခွင့်                                |
| 15. **ဖော်ပြချက်**                           | 16. တိုက်ခိုက်သူသည် စက္ကန့် ၃၀ ခွင့်လွတ်ကာလအတွင်း Pairing Code ကို ကြားဖြတ်ရယူသည်   |
| 17. **တိုက်ခိုက်မှု လမ်းကြောင်း**            | 18. ပခုံးမှကြည့်ခြင်း၊ ကွန်ယက် sniffing၊ လူမှုရေး အင်ဂျင်နီယာလုပ်ရပ်                |
| 19. **ထိခိုက်သက်ရောက်သည့် အစိတ်အပိုင်းများ** | 20. စက်ပစ္စည်း ချိတ်ဆက်ခြင်း စနစ်                                                   |
| 21. **လက်ရှိ ကာကွယ်ရေး အစီအမံများ**          | 22. စက္ကန့် ၃၀ အတွင်း သက်တမ်းကုန်ဆုံးခြင်း၊ ရှိပြီးသား ချန်နယ်မှ ကုဒ်များ ပို့ခြင်း |
| 23. **ကျန်ရှိသည့် အန္တရာယ်**                 | 24. အလယ်အလတ် — ခွင့်လွတ်ကာလကို အသုံးချနိုင်သည်                                      |
| 25. **အကြံပြုချက်များ**                      | 26. ခွင့်လွတ်ကာလကို လျှော့ချပါ၊ အတည်ပြု အဆင့် ထပ်ထည့်ပါ                             |

#### 27. T-ACCESS-002: AllowFrom အတုလုပ်ခြင်း

| 28. အင်္ဂါရပ်                                | Value                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 29. **ATLAS ID**                             | 30. AML.T0040 - AI မော်ဒယ် အနုမာန် API ဝင်ရောက်ခွင့်                                            |
| 31. **ဖော်ပြချက်**                           | 32. တိုက်ခိုက်သူသည် ချန်နယ်အတွင်း ခွင့်ပြုထားသော ပို့သူ အထောက်အထားကို အတုလုပ်သည်                |
| 33. **တိုက်ခိုက်မှု လမ်းကြောင်း**            | 34. ချန်နယ်အပေါ် မူတည်သည် — ဖုန်းနံပါတ် အတုလုပ်ခြင်း၊ အသုံးပြုသူအမည် အယောင်ဆောင်ခြင်း           |
| 35. **ထိခိုက်သက်ရောက်သည့် အစိတ်အပိုင်းများ** | 36. ချန်နယ်အလိုက် AllowFrom စစ်ဆေးအတည်ပြုမှု                                                    |
| 37. **လက်ရှိ ကာကွယ်ရေး အစီအမံများ**          | 38. ချန်နယ်အလိုက် အထောက်အထား စစ်ဆေးအတည်ပြုမှု                                                   |
| 39. **ကျန်ရှိသည့် အန္တရာယ်**                 | 40. အလယ်အလတ် — ချန်နယ်အချို့တွင် အတုလုပ်ခြင်းအတွက် အားနည်းချက်ရှိသည်                            |
| 41. **အကြံပြုချက်များ**                      | 42. ချန်နယ်အလိုက် အန္တရာယ်များကို မှတ်တမ်းတင်ပါ၊ ဖြစ်နိုင်ပါက ခရစ်ပတိုဂရပ်ဖစ် အတည်ပြုမှု ထည့်ပါ |

#### 43. T-ACCESS-003: တိုကင် ခိုးယူခြင်း

| 44. အင်္ဂါရပ်                             | Value                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 45. **ATLAS ID**                          | 46. AML.T0040 - AI မော်ဒယ် အနုမာန် API ဝင်ရောက်ခွင့်                                                   |
| 47. **ဖော်ပြချက်**                        | 48. တိုက်ခိုက်သူသည် config ဖိုင်များမှ အတည်ပြု တိုကင်များကို ခိုးယူသည်                                 |
| 49. **တိုက်ခိုက်မှု လမ်းကြောင်း**         | 50. မယ်လ်ဝဲ၊ ခွင့်မပြုထားသော စက်ပစ္စည်း ဝင်ရောက်မှု၊ config backup ပေါက်ကြားမှု                        |
| 1. **သက်ရောက်မှုရှိသော အစိတ်အပိုင်းများ** | 2. ~/.openclaw/credentials/, ပြင်ဆင်မှုသိမ်းဆည်းရာနေရာ                                                 |
| 3. **လက်ရှိ လျှော့ချရေး အစီအမံများ**      | ဖိုင် permissions                                                                                      |
| 4. **ကျန်ရှိသော အန္တရာယ်**                | 5. အမြင့် - တိုကင်များကို plaintext အဖြစ် သိမ်းဆည်းထားသည်                                              |
| 6. **အကြံပြုချက်များ**                    | 7. သိမ်းဆည်းထားသည့်အခါ တိုကင်ကို အင်ကရစ်ရှင်း ပြုလုပ်ခြင်း၊ တိုကင် လှည့်လည်ပြောင်းလဲမှု ထည့်သွင်းခြင်း |

---

### 8. 3.3 လုပ်ဆောင်ခြင်း (AML.TA0005)

#### 9. T-EXEC-001: တိုက်ရိုက် Prompt Injection

| 10. အင်္ဂါရပ်                              | Value                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 11. **ATLAS ID**                           | 12. AML.T0051.000 - LLM Prompt Injection: တိုက်ရိုက်                                                                  |
| 13. **ဖော်ပြချက်**                         | 14. တိုက်ခိုက်သူက အေးဂျင့်၏ လုပ်ဆောင်ပုံကို ချိုးဖောက်ရန် ဖန်တီးထားသော prompt များကို ပို့သည်                         |
| 15. **တိုက်ခိုက်မှု လမ်းကြောင်း**          | 16. ဆန့်ကျင်ဘက် ညွှန်ကြားချက်များ ပါဝင်သော ချန်နယ် မက်ဆေ့ခ်ျများ                                                      |
| 17. **သက်ရောက်မှုရှိသော အစိတ်အပိုင်းများ** | 18. Agent LLM၊ ထည့်သွင်းမှု မျက်နှာပြင်အားလုံး                                                                        |
| 19. **လက်ရှိ လျှော့ချရေး အစီအမံများ**      | 20. ပုံစံ ခွဲခြားသိရှိခြင်း၊ ပြင်ပအကြောင်းအရာကို ထုပ်ပိုးခြင်း                                                        |
| 21. **ကျန်ရှိသော အန္တရာယ်**                | 22. အလွန်ပြင်းထန် - ရှာဖွေသိရှိမှုသာရှိပြီး ပိတ်ဆို့မှုမရှိ၊ အဆင့်မြင့် တိုက်ခိုက်မှုများက ကျော်လွှားနိုင်သည်         |
| 23. **အကြံပြုချက်များ**                    | 24. အလွှာစုံ ကာကွယ်ရေး အကောင်အထည်ဖော်ခြင်း၊ အထွက်အတည်ပြုခြင်း၊ အရေးကြီး လုပ်ဆောင်ချက်များအတွက် အသုံးပြုသူ အတည်ပြုချက် |

#### 25. T-EXEC-002: မတိုက်ရိုက် Prompt Injection

| 26. အင်္ဂါရပ်                              | Value                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 27. **ATLAS ID**                           | 28. AML.T0051.001 - LLM Prompt Injection: မတိုက်ရိုက်                                             |
| **Description**                            | 30. တိုက်ခိုက်သူက ရယူလာသော အကြောင်းအရာအတွင်း မကောင်းသော ညွှန်ကြားချက်များကို ထည့်သွင်းထားသည်      |
| 31. **တိုက်ခိုက်မှု လမ်းကြောင်း**          | 32. မကောင်းသော URL များ၊ အဆိပ်ထည့်ထားသော အီးမေးလ်များ၊ ချိုးဖောက်ခံထားရသော webhook များ           |
| 33. **သက်ရောက်မှုရှိသော အစိတ်အပိုင်းများ** | 34. web_fetch၊ အီးမေးလ် ထည့်သွင်းရယူမှု၊ ပြင်ပ ဒေတာ အရင်းအမြစ်များ                                |
| 35. **လက်ရှိ လျှော့ချရေး အစီအမံများ**      | 36. XML တက်ဂ်များနှင့် လုံခြုံရေး အသိပေးချက်ဖြင့် အကြောင်းအရာ ထုပ်ပိုးခြင်း                       |
| 37. **ကျန်ရှိသော အန္တရာယ်**                | 38. အမြင့် - LLM က ထုပ်ပိုးထားသော ညွှန်ကြားချက်များကို လျစ်လျူရှုနိုင်သည်                         |
| 39. **အကြံပြုချက်များ**                    | 40. အကြောင်းအရာ သန့်စင်ခြင်း အကောင်အထည်ဖော်ခြင်း၊ လုပ်ဆောင်မှု ပတ်ဝန်းကျင်များကို ခွဲခြားထားခြင်း |

#### 41. T-EXEC-003: ကိရိယာ အငြင်းအချက် အင်ဂျက်ရှင်း

| 42. အင်္ဂါရပ်                              | Value                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 43. **ATLAS ID**                           | 44. AML.T0051.000 - LLM Prompt Injection: တိုက်ရိုက်                                             |
| 45. **ဖော်ပြချက်**                         | 46. တိုက်ခိုက်သူက prompt injection မှတစ်ဆင့် ကိရိယာ အငြင်းအချက်များကို ချိုးဖောက် ပြောင်းလဲစေသည် |
| 47. **တိုက်ခိုက်မှု လမ်းကြောင်း**          | 48. ကိရိယာ ပါရာမီတာ တန်ဖိုးများကို သက်ရောက်စေသော ဖန်တီးထားသော prompt များ                        |
| 49. **သက်ရောက်မှုရှိသော အစိတ်အပိုင်းများ** | 50. ကိရိယာ ခေါ်ယူအသုံးပြုမှု အားလုံး                                                             |
| **Current Mitigations**                    | Exec approvals for dangerous commands                                                            |
| **Residual Risk**                          | High - Relies on user judgment                                                                   |
| **Recommendations**                        | Implement argument validation, parameterized tool calls                                          |

#### T-EXEC-004: Exec Approval Bypass

| Attribute               | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                         |
| **Description**         | Attacker crafts commands that bypass approval allowlist    |
| **Attack Vector**       | Command obfuscation, alias exploitation, path manipulation |
| **Affected Components** | exec-approvals.ts, command allowlist                       |
| **Current Mitigations** | Allowlist + ask mode                                       |
| **Residual Risk**       | High - No command sanitization                             |
| **Recommendations**     | Implement command normalization, expand blocklist          |

---

### 3.4 Persistence (AML.TA0006)

#### T-PERSIST-001: Malicious Skill Installation

| Attribute               | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                     |
| **Description**         | Attacker publishes malicious skill to ClawHub                            |
| **Attack Vector**       | Create account, publish skill with hidden malicious code                 |
| **Affected Components** | ClawHub, skill loading, agent execution                                  |
| **Current Mitigations** | GitHub account age verification, pattern-based moderation flags          |
| **Residual Risk**       | Critical - No sandboxing, limited review                                 |
| **Recommendations**     | VirusTotal integration (in progress), skill sandboxing, community review |

#### T-PERSIST-002: Skill Update Poisoning

| Attribute               | Value                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                                                                                            |
| **Description**         | Attacker compromises popular skill and pushes malicious update                                                                                  |
| **Attack Vector**       | Account compromise, social engineering of skill owner                                                                                           |
| **Affected Components** | ClawHub versioning, auto-update flows                                                                                                           |
| **Current Mitigations** | ဗားရှင်း လက်ဗွေမှတ်တမ်းခြေရာခံခြင်း                                                                                                             |
| **ကျန်ရှိသော အန္တရာယ်** | မြင့်မားသည် - အလိုအလျောက် အပ်ဒိတ်များက အန္တရာယ်ရှိသော ဗားရှင်းများကို ဆွဲယူနိုင်သည်                                                             |
| **အကြံပြုချက်များ**     | အပ်ဒိတ် လက်မှတ်ရေးထိုးခြင်း၊ ပြန်လည်နောက်ပြန်သွားနိုင်စွမ်း (rollback)၊ ဗားရှင်းကို ချိတ်ဆွဲသတ်မှတ်ခြင်း (version pinning) ကို အကောင်အထည်ဖော်ပါ |

#### T-PERSIST-003: အေးဂျင့် ဖွဲ့စည်းမှု ပြုပြင်ချိုးဖောက်ခြင်း

| အင်္ဂါရပ်                       | Value                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **ATLAS ID**                    | AML.T0010.002 - ထောက်ပံ့ကွင်းဆက် ချိုးဖောက်မှု: ဒေတာ                                                 |
| **ဖော်ပြချက်**                  | တိုက်ခိုက်သူသည် အေးဂျင့် ဖွဲ့စည်းမှုကို ပြင်ဆင်၍ ဝင်ရောက်ခွင့်ကို ဆက်လက်တည်တံ့စေရန် လုပ်ဆောင်သည်     |
| **တိုက်ခိုက်နည်းလမ်း**          | ဖွဲ့စည်းမှုဖိုင် ပြင်ဆင်ခြင်း၊ ဆက်တင် ထည့်သွင်းခြင်း                                                 |
| **ထိခိုက်သော အစိတ်အပိုင်းများ** | အေးဂျင့် ဖွဲ့စည်းမှု၊ ကိရိယာ မူဝါဒများ                                                               |
| **လက်ရှိ ကာကွယ်ရေးများ**        | ဖိုင် permissions                                                                                    |
| **ကျန်ရှိသော အန္တရာယ်**         | အလတ်စား - ဒေသတွင်း ဝင်ရောက်ခွင့် လိုအပ်သည်                                                           |
| **အကြံပြုချက်များ**             | ဖွဲ့စည်းမှု တည်ကြည်မှု စစ်ဆေးခြင်း၊ ဖွဲ့စည်းမှု ပြောင်းလဲမှုများအတွက် စစ်ဆေးမှတ်တမ်း (audit logging) |

---

### 3.5 ကာကွယ်ရေး လွတ်မြောက်မှု (AML.TA0007)

#### T-EVADE-001: မော်ဒရေးရှင်း ပုံစံ ရှောင်လွှဲခြင်း

| အင်္ဂါရပ်                       | Value                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| **ATLAS ID**                    | AML.T0043 - ဆန့်ကျင်ဘက် ဒေတာ ဖန်တီးခြင်း                                                        |
| **ဖော်ပြချက်**                  | တိုက်ခိုက်သူသည် မော်ဒရေးရှင်း ပုံစံများကို ရှောင်လွှဲနိုင်ရန် စွမ်းရည် အကြောင်းအရာကို ဖန်တီးသည် |
| **တိုက်ခိုက်နည်းလမ်း**          | Unicode ဟိုမိုဂလစ်ဖ်များ၊ အင်ကုဒင်း လှည့်ကွက်များ၊ ဒိုင်နမစ် လုပ်ဆောင်မှု ထည့်သွင်းခြင်း        |
| **ထိခိုက်သော အစိတ်အပိုင်းများ** | ClawHub moderation.ts                                                                           |
| **လက်ရှိ ကာကွယ်ရေးများ**        | ပုံစံအခြေပြု FLAG_RULES                                                                         |
| **ကျန်ရှိသော အန္တရာယ်**         | မြင့်မားသည် - ရိုးရှင်းသော regex ကို လွယ်ကူစွာ ရှောင်လွှဲနိုင်သည်                               |
| **အကြံပြုချက်များ**             | အပြုအမူ ခွဲခြမ်းစိတ်ဖြာမှု (VirusTotal Code Insight)၊ AST အခြေပြု တွေ့ရှိမှုကို ထည့်သွင်းပါ     |

#### T-EVADE-002: အကြောင်းအရာ Wrapper မှ လွတ်မြောက်ခြင်း

| အင်္ဂါရပ်                       | Value                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| **ATLAS ID**                    | AML.T0043 - ဆန့်ကျင်ဘက် ဒေတာ ဖန်တီးခြင်း                                              |
| **ဖော်ပြချက်**                  | တိုက်ခိုက်သူသည် XML wrapper အကြောင်းအရာမှ လွတ်မြောက်နိုင်ရန် အကြောင်းအရာကို ဖန်တီးသည် |
| **တိုက်ခိုက်နည်းလမ်း**          | Tag ပြုပြင်ခြင်း၊ အကြောင်းအရာ ဆက်စပ်မှု ရှုပ်ထွေးစေခြင်း၊ ညွှန်ကြားချက် အစားထိုးခြင်း |
| **ထိခိုက်သော အစိတ်အပိုင်းများ** | ပြင်ပ အကြောင်းအရာ ထုပ်ပိုးခြင်း                                                       |
| **Current Mitigations**         | XML tags + လုံခြုံရေး အသိပေးချက်                                                      |
| **ကျန်ရှိသော အန္တရာယ်**         | Medium - Novel escapes discovered regularly                                           |
| **Recommendations**             | Multiple wrapper layers, output-side validation                                       |

---

### 3.6 Discovery (AML.TA0008)

#### T-DISC-001: Tool Enumeration

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker enumerates available tools through prompting |
| **Attack Vector**       | "What tools do you have?" style queries               |
| **Affected Components** | Agent tool registry                                   |
| **Current Mitigations** | None specific                                         |
| **Residual Risk**       | Low - Tools generally documented                      |
| **Recommendations**     | Consider tool visibility controls                     |

#### T-DISC-002: Session Data Extraction

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker extracts sensitive data from session context |
| **Attack Vector**       | "What did we discuss?" queries, context probing       |
| **Affected Components** | Session transcripts, context window                   |
| **Current Mitigations** | Session isolation per sender                          |
| **Residual Risk**       | Medium - Within-session data accessible               |
| **Recommendations**     | Implement sensitive data redaction in context         |

---

### 3.7 Collection & Exfiltration (AML.TA0009, AML.TA0010)

#### T-EXFIL-001: Data Theft via web_fetch

| Attribute               | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                 |
| **Description**         | Attacker exfiltrates data by instructing agent to send to external URL |
| **Attack Vector**       | Prompt injection causing agent to POST data to attacker server         |
| **Affected Components** | web_fetch tool                                                         |
| **Current Mitigations** | SSRF blocking for internal networks                                    |
| **Residual Risk**       | High - External URLs permitted                                         |
| **Recommendations**     | Implement URL allowlisting, data classification awareness              |

#### T-EXFIL-002: Unauthorized Message Sending

| Attribute               | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                           |
| **Description**         | Attacker causes agent to send messages containing sensitive data |
| **Attack Vector**       | Prompt injection causing agent to message attacker               |
| **Affected Components** | Message tool, channel integrations                               |
| **Current Mitigations** | Outbound messaging gating                                        |
| **Residual Risk**       | Medium - Gating may be bypassed                                  |
| **Recommendations**     | Require explicit confirmation for new recipients                 |

#### T-EXFIL-003: Credential Harvesting

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                  |
| **Description**         | Malicious skill harvests credentials from agent context |
| **Attack Vector**       | Skill code reads environment variables, config files    |
| **Affected Components** | Skill execution environment                             |
| **Current Mitigations** | None specific to skills                                 |
| **Residual Risk**       | Critical - Skills run with agent privileges             |
| **Recommendations**     | Skill sandboxing, credential isolation                  |

---

### 3.8 Impact (AML.TA0011)

#### T-IMPACT-001: Unauthorized Command Execution

| Attribute               | Value                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                                       |
| **Description**         | Attacker executes arbitrary commands on user system                        |
| **Attack Vector**       | Prompt injection combined with exec approval bypass                        |
| **Affected Components** | Bash tool, command execution                                               |
| **Current Mitigations** | Exec approvals, Docker sandbox option                                      |
| **Residual Risk**       | Critical - Host execution without sandbox                                  |
| 1. **အကြံပြုချက်များ**  | 2. ပုံမှန်အားဖြင့် sandbox သုံးရန်၊ ခွင့်ပြုမှု UX ကို တိုးတက်အောင်လုပ်ရန် |

#### 3. T-IMPACT-002: အရင်းအမြစ် ကုန်ခန်းမှု (DoS)

| 4. လက္ခဏာ                        | Value                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| 5. **ATLAS ID**                  | 6. AML.T0031 - AI မော်ဒယ်၏ တည်ကြည်မှုကို ချိုးဖောက်ခြင်း                                      |
| 7. **ဖော်ပြချက်**                | 8. တိုက်ခိုက်သူက API credit များ သို့မဟုတ် တွက်ချက်ရေး အရင်းအမြစ်များကို ကုန်ခန်းအောင်လုပ်သည် |
| 9. **တိုက်ခိုက်မှု လမ်းကြောင်း** | 10. အလိုအလျောက် စာတိုများ များပြားစွာ ပို့ခြင်း၊ ကုန်ကျစရိတ်မြင့် tool ခေါ်ယူမှုများ          |
| **Affected Components**          | 12. Gateway၊ agent session များ၊ API ပံ့ပိုးသူ                                                |
| 13. **လက်ရှိ ကာကွယ်မှုများ**     | 14. မရှိ                                                                                      |
| 15. **ကျန်ရှိသည့် အန္တရာယ်**     | 16. မြင့်မား — rate limiting မရှိ                                                             |
| 17. **အကြံပြုချက်များ**          | 18. ပို့သူတစ်ဦးချင်းစီအလိုက် rate limit များ၊ ကုန်ကျစရိတ် ဘတ်ဂျက်များ ကို အကောင်အထည်ဖော်ရန်   |

#### 19. T-IMPACT-003: ဂုဏ်သတင်း ထိခိုက်မှု

| 20. လက္ခဏာ                          | Value                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| 21. **ATLAS ID**                    | 22. AML.T0031 - AI မော်ဒယ်၏ တည်ကြည်မှုကို ချိုးဖောက်ခြင်း                           |
| 23. **ဖော်ပြချက်**                  | 24. တိုက်ခိုက်သူက agent ကို အန္တရာယ်ရှိ သို့မဟုတ် အပြစ်ပြုစရာ အကြောင်းအရာ ပို့စေသည် |
| 25. **တိုက်ခိုက်မှု လမ်းကြောင်း**   | 26. မသင့်လျော်သော တုံ့ပြန်ချက်များ ဖြစ်စေသည့် prompt injection                      |
| 27. **သက်ရောက်ခံ အစိတ်အပိုင်းများ** | 28. အထွက်အမြောက် ထုတ်လုပ်မှု၊ ချန်နယ် စာတိုပို့ခြင်း                                |
| 29. **လက်ရှိ ကာကွယ်မှုများ**        | 30. LLM ပံ့ပိုးသူ၏ အကြောင်းအရာ မူဝါဒများ                                            |
| 31. **ကျန်ရှိသည့် အန္တရာယ်**        | 32. အလတ်စား — ပံ့ပိုးသူ filter များ မပြည့်စုံ                                       |
| 33. **အကြံပြုချက်များ**             | 34. အထွက်အမြောက် စစ်ထုတ်ခြင်း အလွှာ၊ အသုံးပြုသူ ထိန်းချုပ်မှုများ                   |

---

## 10. 4. 35. ClawHub ပံ့ပိုးမှုကွင်းဆက် ဆန်းစစ်ခြင်း

### 36. 4.1 လက်ရှိ လုံခြုံရေး ထိန်းချုပ်မှုများ

| 37. ထိန်းချုပ်မှု                | Implementation                  | 38. ထိရောက်မှု                                                         |
| -------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| 39. GitHub အကောင့် အသက်တမ်း      | 40. `requireGitHubAccountAge()` | 41. အလတ်စား — တိုက်ခိုက်သူ အသစ်များအတွက် အတားအဆီး မြှင့်တင်သည်         |
| 42. လမ်းကြောင်း သန့်စင်ခြင်း     | 43. `sanitizePath()`            | 44. မြင့်မား — path traversal ကို တားဆီးသည်                            |
| 45. ဖိုင် အမျိုးအစား စစ်ဆေးခြင်း | 46. `isTextFile()`              | 47. အလတ်စား — စာသားဖိုင်များသာ ခွင့်ပြုသော်လည်း အန္တရာယ်ရှိနိုင်သေးသည် |
| 48. အရွယ်အစား ကန့်သတ်ချက်များ    | 49. စုစုပေါင်း bundle 50MB      | 50. မြင့်မား — အရင်းအမြစ် ကုန်ခန်းမှုကို တားဆီးသည်                     |
| Required SKILL.md                | Mandatory readme                | Low security value - Informational only                                |
| Pattern Moderation               | FLAG_RULES in moderation.ts     | Low - Easily bypassed                                                  |
| Moderation Status                | `moderationStatus` field        | Medium - Manual review possible                                        |

### 4.2 Moderation Flag Patterns

Current patterns in `moderation.ts`:

```javascript
// Known-bad identifiers
/(keepcold131\/ClawdAuthenticatorTool|ClawdAuthenticatorTool)/i

// Suspicious keywords
/(malware|stealer|phish|phishing|keylogger)/i
/(api[-_ ]?key|token|password|private key|secret)/i
/(wallet|seed phrase|mnemonic|crypto)/i
/(discord\.gg|webhook|hooks\.slack)/i
/(curl[^\n]+\|\s*(sh|bash))/i
/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)/i
```

**Limitations:**

- Only checks slug, displayName, summary, frontmatter, metadata, file paths
- Does not analyze actual skill code content
- Simple regex easily bypassed with obfuscation
- No behavioral analysis

### 4.3 Planned Improvements

| Improvement            | အခြေအနေ                               | Impact                                                                |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| VirusTotal Integration | In Progress                           | High - Code Insight behavioral analysis                               |
| Community Reporting    | Partial (`skillReports` table exists) | Medium                                                                |
| Audit Logging          | Partial (`auditLogs` table exists)    | Medium                                                                |
| Badge System           | Implemented                           | Medium - `highlighted`, `official`, `deprecated`, `redactionApproved` |

---

## 5. Risk Matrix

### 5.1 Likelihood vs Impact

| Threat ID     | Likelihood   | Impact           | Risk Level      | Priority      |
| ------------- | ------------ | ---------------- | --------------- | ------------- |
| T-EXEC-001    | High         | Critical         | **Critical**    | P0            |
| T-PERSIST-001 | High         | Critical         | **Critical**    | P0            |
| T-EXFIL-003   | အရေးကြီးဆုံး | **အရေးကြီးဆုံး** | P0              | T-IMPACT-001  |
| အလတ်အဆင့်     | အရေးကြီးဆုံး | **အမြင့်**       | P1              | T-EXEC-002    |
| အမြင့်        | အမြင့်       | **အမြင့်**       | P1              | T-EXEC-004    |
| အလတ်အဆင့်     | အမြင့်       | **အမြင့်**       | P1              | T-ACCESS-003  |
| အလတ်အဆင့်     | အမြင့်       | **အမြင့်**       | P1              | T-EXFIL-001   |
| အလတ်အဆင့်     | အမြင့်       | **အမြင့်**       | P1              | T-IMPACT-002  |
| အမြင့်        | အလတ်အဆင့်    | **အမြင့်**       | P1              | T-EVADE-001   |
| အမြင့်        | အလတ်အဆင့်    | **အလတ်အဆင့်**    | P2              | T-ACCESS-001  |
| နိမ့်         | အမြင့်       | **အလတ်အဆင့်**    | P2              | T-ACCESS-002  |
| နိမ့်         | အမြင့်       | **အလတ်အဆင့်**    | P2              | T-PERSIST-002 |
| T-PERSIST-002 | Low          | High             | 3. **အလယ်အလတ်** | 4. P2         |

### 5. 5.2 အရေးပါသော လမ်းကြောင်း တိုက်ခိုက်မှု ချိတ်ဆက်ကွင်းများ

6. **တိုက်ခိုက်မှု ချိတ်ဆက်ကွင်း ၁: ကျွမ်းကျင်မှုအခြေပြု ဒေတာ ခိုးယူမှု**

```
7. T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003
(အန္တရာယ်ရှိသော skill ကို ထုတ်ပြန်ခြင်း) → (စိစစ်ထိန်းချုပ်မှုကို ရှောင်လွှဲခြင်း) → (အကောင့်အထောက်အထားများ စုဆောင်းခြင်း)
```

8. **တိုက်ခိုက်မှု ချိတ်ဆက်ကွင်း ၂: Prompt Injection မှ RCE သို့**

```
9. T-EXEC-001 → T-EXEC-004 → T-IMPACT-001
(Prompt ထိုးသွင်းခြင်း) → (exec ခွင့်ပြုချက်ကို ကျော်လွှားခြင်း) → (အမိန့်များ လုပ်ဆောင်ခြင်း)
```

10. **တိုက်ခိုက်မှု ချိတ်ဆက်ကွင်း ၃: ရယူထားသော အကြောင်းအရာမှတစ်ဆင့် အကြမ်းဖက် ထိုးသွင်းခြင်း**

```
11. T-EXEC-002 → T-EXFIL-001 → External exfiltration
(URL အကြောင်းအရာကို အဆိပ်သင့်စေခြင်း) → (Agent က ရယူပြီး အညွှန်းများကို လိုက်နာခြင်း) → (ဒေတာကို တိုက်ခိုက်သူထံ ပို့ခြင်း)
```

---

## 6. 12. အကြံပြုချက်များ အကျဉ်းချုပ်

### 13. 6.1 ချက်ချင်း (P0)

| 14. ID    | 15. အကြံပြုချက်                                                           | 16. ကိုင်တွယ်ဖြေရှင်းသည့် အချက်များ |
| --------- | ------------------------------------------------------------------------- | ----------------------------------- |
| 17. R-001 | 18. VirusTotal ပေါင်းစည်းမှုကို အပြည့်အဝ ဆောင်ရွက်ပါ                      | 19. T-PERSIST-001, T-EVADE-001      |
| 20. R-002 | 21. skill sandboxing ကို အကောင်အထည်ဖော်ပါ                                 | 22. T-PERSIST-001, T-EXFIL-003      |
| 23. R-003 | 24. အရေးကြီးသော လုပ်ဆောင်ချက်များအတွက် output စိစစ်အတည်ပြုမှု ထည့်သွင်းပါ | 25. T-EXEC-001, T-EXEC-002          |

### 26. 6.2 အချိန်တို (P1)

| 27. ID    | 28. အကြံပြုချက်                                                                    | 29. ကိုင်တွယ်ဖြေရှင်းသည့် အချက်များ |
| --------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| 30. R-004 | 31. rate limiting ကို အကောင်အထည်ဖော်ပါ                                             | 32. T-IMPACT-002                    |
| 33. R-005 | 34. token များကို သိမ်းဆည်းထားစဉ် encryption ထည့်သွင်းပါ                           | 35. T-ACCESS-003                    |
| 36. R-006 | 37. exec ခွင့်ပြုချက် UX နှင့် စိစစ်အတည်ပြုမှုကို တိုးတက်ကောင်းမွန်အောင် ပြုလုပ်ပါ | 38. T-EXEC-004                      |
| R-007     | 40. web_fetch အတွက် URL allowlisting ကို အကောင်အထည်ဖော်ပါ                          | 41. T-EXFIL-001                     |

### 42. 6.3 အလယ်အလတ်ကာလ (P2)

| 43. ID    | 44. အကြံပြုချက်                                                            | 45. ကိုင်တွယ်ဖြေရှင်းသည့် အချက်များ |
| --------- | -------------------------------------------------------------------------- | ----------------------------------- |
| 46. R-008 | 47. ဖြစ်နိုင်သည့်နေရာများတွင် cryptographic channel အတည်ပြုမှု ထည့်သွင်းပါ | 48. T-ACCESS-002                    |
| 49. R-009 | 50. config အပြည့်အဝတည်ကြည်မှု စိစစ်အတည်ပြုမှုကို အကောင်အထည်ဖော်ပါ          | T-PERSIST-003                       |
| R-010     | Add update signing and version pinning                                     | T-PERSIST-002                       |

---

## 7. Appendices

### 7.1 ATLAS Technique Mapping

| ATLAS ID      | Technique Name                 | OpenClaw Threats                                                 |
| ------------- | ------------------------------ | ---------------------------------------------------------------- |
| AML.T0006     | Active Scanning                | T-RECON-001, T-RECON-002                                         |
| AML.T0009     | Collection                     | T-EXFIL-001, T-EXFIL-002, T-EXFIL-003                            |
| AML.T0010.001 | Supply Chain: AI Software      | T-PERSIST-001, T-PERSIST-002                                     |
| AML.T0010.002 | Supply Chain: Data             | T-PERSIST-003                                                    |
| AML.T0031     | Erode AI Model Integrity       | T-IMPACT-001, T-IMPACT-002, T-IMPACT-003                         |
| AML.T0040     | AI Model Inference API Access  | T-ACCESS-001, T-ACCESS-002, T-ACCESS-003, T-DISC-001, T-DISC-002 |
| AML.T0043     | Craft Adversarial Data         | T-EXEC-004, T-EVADE-001, T-EVADE-002                             |
| AML.T0051.000 | LLM Prompt Injection: Direct   | T-EXEC-001, T-EXEC-003                                           |
| AML.T0051.001 | LLM Prompt Injection: Indirect | T-EXEC-002                                                       |

### 7.2 Key Security Files

| ၃၁. Path                               | Purpose                                | Risk Level           |
| -------------------------------------- | -------------------------------------- | -------------------- |
| `src/infra/exec-approvals.ts`          | Command approval logic                 | **Critical**         |
| `src/gateway/auth.ts`                  | Gateway authentication                 | **Critical**         |
| `src/web/inbound/access-control.ts`    | Channel access control                 | **Critical**         |
| `src/infra/net/ssrf.ts`                | SSRF protection                        | **Critical**         |
| `src/security/external-content.ts`     | 1. Prompt injection ကာကွယ်ရေး          | 2. **အလွန်အရေးကြီး** |
| 3. `src/agents/sandbox/tool-policy.ts` | 4. Tool မူဝါဒ အတည်ပြုအကောင်အထည်ဖော်မှု | 5. **အလွန်အရေးကြီး** |
| 6. `convex/lib/moderation.ts`          | 7. ClawHub စိစစ်ထိန်းချုပ်မှု          | 8. **အမြင့်**        |
| 9. `convex/lib/skillPublish.ts`        | 10. Skill ထုတ်ဝေမှု လုပ်ငန်းစဉ်        | 11. **အမြင့်**       |
| 12. `src/routing/resolve-route.ts`     | 13. Session ခွဲခြားထားမှု              | 14. **အလတ်အလတ်**     |

### 15. 7.3 ဝေါဟာရများ

| 16. ဝေါဟာရ               | 17. အဓိပ္ပါယ်ဖော်ပြချက်                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| 18. **ATLAS**            | 19. MITRE ၏ AI စနစ်များအတွက် ဆန့်ကျင်ဘက်ခြိမ်းခြောက်မှု မြေပြင်အနေအထား             |
| 20. **ClawHub**          | 21. OpenClaw ၏ skill စျေးကွက်                                                      |
| **Gateway**              | 22. OpenClaw ၏ မက်ဆေ့ချ် လမ်းကြောင်းညွှန်နှင့် အတည်ပြုခြင်း အလွှာ                  |
| 23. **MCP**              | 24. Model Context Protocol - tool ပံ့ပိုးသူ အင်တာဖေ့စ်                             |
| 25. **Prompt Injection** | 26. အန္တရာယ်ရှိသော ညွှန်ကြားချက်များကို input အတွင်း ထည့်သွင်းထားသော တိုက်ခိုက်မှု |
| 27. **Skill**            | 28. OpenClaw agent များအတွက် ဒေါင်းလုဒ်လုပ်နိုင်သော တိုးချဲ့မှု                    |
| 29. **SSRF**             | 30. Server-Side Request Forgery                                                    |

---

31. _ဤခြိမ်းခြောက်မှု မော်ဒယ်သည် အမြဲတမ်း ပြောင်းလဲတိုးတက်နေသော စာတမ်းဖြစ်သည်။ 32. လုံခြုံရေး ပြဿနာများကို security@openclaw.ai သို့ တင်ပြပါ_
