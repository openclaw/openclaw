---
x-i18n:
    generated_at: "2026-02-08T16:11:32Z"
    model: gtx
    provider: google-translate
    source_hash: 97dce2d990a412691b52f0e640cf1bc5bcf577c9bf20bbf732bf9c70394ef102
    source_path: security/THREAT-MODEL-ATLAS.md
    workflow: 15
---

# OpenClaw 위협 모델 v1.0

## MITRE ATLAS 프레임워크

**버전:** 1.0-초안
**마지막 업데이트:** 2026-02-04
**방법론:** MITRE ATLAS + 데이터 흐름 다이어그램
**뼈대:** [마이터 아틀라스](https://atlas.mitre.org/) (AI 시스템을 위한 적대적 위협 환경)

### 프레임워크 기여

이 위협 모델은 다음을 기반으로 합니다. [마이터 아틀라스](https://atlas.mitre.org/), AI/ML 시스템에 대한 적대적 위협을 문서화하기 위한 업계 표준 프레임워크입니다. ATLAS는 다음에 의해 유지 관리됩니다. [연귀](https://www.mitre.org/) AI 보안 커뮤니티와 협력해

**주요 ATLAS 리소스:**

- [아틀라스 기술](https://atlas.mitre.org/techniques/)
- [아틀라스 전술](https://atlas.mitre.org/tactics/)
- [ATLAS 사례 연구](https://atlas.mitre.org/studies/)
- [아틀라스 GitHub](https://github.com/mitre-atlas/atlas-data)
- [ATLAS에 기여](https://atlas.mitre.org/resources/contribute)

### 이 위협 모델에 기여

이는 OpenClaw 커뮤니티에서 유지 관리하는 살아있는 문서입니다. 보다 [기여-위협-모델.md](./CONTRIBUTING-THREAT-MODEL.md) 기여에 대한 지침은 다음을 참조하세요.

- 새로운 위협 보고
- 기존 위협 업데이트
- 공격 체인 제안
- 완화 제안

---

## 1. 소개

### 1.1 목적

이 위협 모델은 AI/ML 시스템용으로 특별히 설계된 MITRE ATLAS 프레임워크를 사용하여 OpenClaw AI 에이전트 플랫폼 및 ClawHub 기술 시장에 대한 적대적 위협을 문서화합니다.

### 1.2 범위

| Component              | Included | Notes                                            |
| ---------------------- | -------- | ------------------------------------------------ |
| OpenClaw Agent Runtime | Yes      | Core agent execution, tool calls, sessions       |
| Gateway                | Yes      | Authentication, routing, channel integration     |
| Channel Integrations   | Yes      | WhatsApp, Telegram, Discord, Signal, Slack, etc. |
| ClawHub Marketplace    | Yes      | Skill publishing, moderation, distribution       |
| MCP Servers            | Yes      | External tool providers                          |
| User Devices           | Partial  | Mobile apps, desktop clients                     |

### 1.3 범위 외

이 위협 모델의 범위를 명시적으로 벗어나는 것은 없습니다.

---

## 2. 시스템 아키텍처

### 2.1 신뢰 경계

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

### 2.2 데이터 흐름

| Flow | Source  | Destination | Data               | Protection           |
| ---- | ------- | ----------- | ------------------ | -------------------- |
| F1   | Channel | Gateway     | User messages      | TLS, AllowFrom       |
| F2   | Gateway | Agent       | Routed messages    | Session isolation    |
| F3   | Agent   | Tools       | Tool invocations   | Policy enforcement   |
| F4   | Agent   | External    | web_fetch requests | SSRF blocking        |
| F5   | ClawHub | Agent       | Skill code         | Moderation, scanning |
| F6   | Agent   | Channel     | Responses          | Output filtering     |

---

## 3. ATLAS Tactic을 통한 위협 분석

### 3.1 정찰(AML.TA0002)

#### T-RECON-001: 에이전트 엔드포인트 검색

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                          |
| **Description**         | Attacker scans for exposed OpenClaw gateway endpoints                |
| **Attack Vector**       | Network scanning, shodan queries, DNS enumeration                    |
| **Affected Components** | Gateway, exposed API endpoints                                       |
| **Current Mitigations** | Tailscale auth option, bind to loopback by default                   |
| **Residual Risk**       | Medium - Public gateways discoverable                                |
| **Recommendations**     | Document secure deployment, add rate limiting on discovery endpoints |

#### T-RECON-002: 채널 통합 조사

| Attribute               | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                        |
| **Description**         | Attacker probes messaging channels to identify AI-managed accounts |
| **Attack Vector**       | Sending test messages, observing response patterns                 |
| **Affected Components** | All channel integrations                                           |
| **Current Mitigations** | None specific                                                      |
| **Residual Risk**       | Low - Limited value from discovery alone                           |
| **Recommendations**     | Consider response timing randomization                             |

---

### 3.2 초기 액세스(AML.TA0004)

#### T-ACCESS-001: 페어링 코드 차단

| Attribute               | Value                                                    |
| ----------------------- | -------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                |
| **Description**         | Attacker intercepts pairing code during 30s grace period |
| **Attack Vector**       | Shoulder surfing, network sniffing, social engineering   |
| **Affected Components** | Device pairing system                                    |
| **Current Mitigations** | 30s expiry, codes sent via existing channel              |
| **Residual Risk**       | Medium - Grace period exploitable                        |
| **Recommendations**     | Reduce grace period, add confirmation step               |

#### T-ACCESS-002: 스푸핑 허용

| Attribute               | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                      |
| **Description**         | Attacker spoofs allowed sender identity in channel                             |
| **Attack Vector**       | Depends on channel - phone number spoofing, username impersonation             |
| **Affected Components** | AllowFrom validation per channel                                               |
| **Current Mitigations** | Channel-specific identity verification                                         |
| **Residual Risk**       | Medium - Some channels vulnerable to spoofing                                  |
| **Recommendations**     | Document channel-specific risks, add cryptographic verification where possible |

#### T-ACCESS-003: 토큰 도난

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                   |
| **Description**         | Attacker steals authentication tokens from config files     |
| **Attack Vector**       | Malware, unauthorized device access, config backup exposure |
| **Affected Components** | ~/.openclaw/credentials/, config storage                    |
| **Current Mitigations** | File permissions                                            |
| **Residual Risk**       | High - Tokens stored in plaintext                           |
| **Recommendations**     | Implement token encryption at rest, add token rotation      |

---

### 3.3 실행(AML.TA0005)

#### T-EXEC-001: 직접 프롬프트 주입

| Attribute               | Value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                                              |
| **Description**         | Attacker sends crafted prompts to manipulate agent behavior                               |
| **Attack Vector**       | Channel messages containing adversarial instructions                                      |
| **Affected Components** | Agent LLM, all input surfaces                                                             |
| **Current Mitigations** | Pattern detection, external content wrapping                                              |
| **Residual Risk**       | Critical - Detection only, no blocking; sophisticated attacks bypass                      |
| **Recommendations**     | Implement multi-layer defense, output validation, user confirmation for sensitive actions |

#### T-EXEC-002: 간접 프롬프트 주입

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.001 - LLM Prompt Injection: Indirect              |
| **Description**         | Attacker embeds malicious instructions in fetched content   |
| **Attack Vector**       | Malicious URLs, poisoned emails, compromised webhooks       |
| **Affected Components** | web_fetch, email ingestion, external data sources           |
| **Current Mitigations** | Content wrapping with XML tags and security notice          |
| **Residual Risk**       | High - LLM may ignore wrapper instructions                  |
| **Recommendations**     | Implement content sanitization, separate execution contexts |

#### T-EXEC-003: 도구 인수 삽입

| Attribute               | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                 |
| **Description**         | Attacker manipulates tool arguments through prompt injection |
| **Attack Vector**       | Crafted prompts that influence tool parameter values         |
| **Affected Components** | All tool invocations                                         |
| **Current Mitigations** | Exec approvals for dangerous commands                        |
| **Residual Risk**       | High - Relies on user judgment                               |
| **Recommendations**     | Implement argument validation, parameterized tool calls      |

#### T-EXEC-004: 임원 승인 우회

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

### 3.4 지속성(AML.TA0006)

#### T-PERSIST-001: 악성 스킬 설치

| Attribute               | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                     |
| **Description**         | Attacker publishes malicious skill to ClawHub                            |
| **Attack Vector**       | Create account, publish skill with hidden malicious code                 |
| **Affected Components** | ClawHub, skill loading, agent execution                                  |
| **Current Mitigations** | GitHub account age verification, pattern-based moderation flags          |
| **Residual Risk**       | Critical - No sandboxing, limited review                                 |
| **Recommendations**     | VirusTotal integration (in progress), skill sandboxing, community review |

#### T-PERSIST-002: 스킬 업데이트 중독

| Attribute               | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software           |
| **Description**         | Attacker compromises popular skill and pushes malicious update |
| **Attack Vector**       | Account compromise, social engineering of skill owner          |
| **Affected Components** | ClawHub versioning, auto-update flows                          |
| **Current Mitigations** | Version fingerprinting                                         |
| **Residual Risk**       | High - Auto-updates may pull malicious versions                |
| **Recommendations**     | Implement update signing, rollback capability, version pinning |

#### T-PERSIST-003: 에이전트 구성 변조

| Attribute               | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.002 - Supply Chain Compromise: Data                   |
| **Description**         | Attacker modifies agent configuration to persist access         |
| **Attack Vector**       | Config file modification, settings injection                    |
| **Affected Components** | Agent config, tool policies                                     |
| **Current Mitigations** | File permissions                                                |
| **Residual Risk**       | Medium - Requires local access                                  |
| **Recommendations**     | Config integrity verification, audit logging for config changes |

---

### 3.5 방어 회피(AML.TA0007)

#### T-EVADE-001: 조정 패턴 우회

| Attribute               | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                     |
| **Description**         | Attacker crafts skill content to evade moderation patterns             |
| **Attack Vector**       | Unicode homoglyphs, encoding tricks, dynamic loading                   |
| **Affected Components** | ClawHub moderation.ts                                                  |
| **Current Mitigations** | Pattern-based FLAG_RULES                                               |
| **Residual Risk**       | High - Simple regex easily bypassed                                    |
| **Recommendations**     | Add behavioral analysis (VirusTotal Code Insight), AST-based detection |

#### T-EVADE-002: 콘텐츠 래퍼 이스케이프

| Attribute               | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                        |
| **Description**         | Attacker crafts content that escapes XML wrapper context  |
| **Attack Vector**       | Tag manipulation, context confusion, instruction override |
| **Affected Components** | External content wrapping                                 |
| **Current Mitigations** | XML tags + security notice                                |
| **Residual Risk**       | Medium - Novel escapes discovered regularly               |
| **Recommendations**     | Multiple wrapper layers, output-side validation           |

---

### 3.6 발견(AML.TA0008)

#### T-DISC-001: 도구 열거

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker enumerates available tools through prompting |
| **Attack Vector**       | "What tools do you have?" style queries               |
| **Affected Components** | Agent tool registry                                   |
| **Current Mitigations** | None specific                                         |
| **Residual Risk**       | Low - Tools generally documented                      |
| **Recommendations**     | Consider tool visibility controls                     |

#### T-DISC-002: 세션 데이터 추출

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

### 3.7 수집 및 유출(AML.TA0009, AML.TA0010)

#### T-EXFIL-001: web_fetch를 통한 데이터 도난

| Attribute               | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                 |
| **Description**         | Attacker exfiltrates data by instructing agent to send to external URL |
| **Attack Vector**       | Prompt injection causing agent to POST data to attacker server         |
| **Affected Components** | web_fetch tool                                                         |
| **Current Mitigations** | SSRF blocking for internal networks                                    |
| **Residual Risk**       | High - External URLs permitted                                         |
| **Recommendations**     | Implement URL allowlisting, data classification awareness              |

#### T-EXFIL-002: 무단 메시지 전송

| Attribute               | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                           |
| **Description**         | Attacker causes agent to send messages containing sensitive data |
| **Attack Vector**       | Prompt injection causing agent to message attacker               |
| **Affected Components** | Message tool, channel integrations                               |
| **Current Mitigations** | Outbound messaging gating                                        |
| **Residual Risk**       | Medium - Gating may be bypassed                                  |
| **Recommendations**     | Require explicit confirmation for new recipients                 |

#### T-EXFIL-003: 자격증명 수집

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

### 3.8 영향(AML.TA0011)

#### T-IMPACT-001: 무단 명령 실행

| Attribute               | Value                                               |
| ----------------------- | --------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                |
| **Description**         | Attacker executes arbitrary commands on user system |
| **Attack Vector**       | Prompt injection combined with exec approval bypass |
| **Affected Components** | Bash tool, command execution                        |
| **Current Mitigations** | Exec approvals, Docker sandbox option               |
| **Residual Risk**       | Critical - Host execution without sandbox           |
| **Recommendations**     | Default to sandbox, improve approval UX             |

#### T-IMPACT-002: 자원 고갈(DoS)

| Attribute               | Value                                              |
| ----------------------- | -------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity               |
| **Description**         | Attacker exhausts API credits or compute resources |
| **Attack Vector**       | Automated message flooding, expensive tool calls   |
| **Affected Components** | Gateway, agent sessions, API provider              |
| **Current Mitigations** | None                                               |
| **Residual Risk**       | High - No rate limiting                            |
| **Recommendations**     | Implement per-sender rate limits, cost budgets     |

#### T-IMPACT-003: 평판 손상

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                    |
| **Description**         | Attacker causes agent to send harmful/offensive content |
| **Attack Vector**       | Prompt injection causing inappropriate responses        |
| **Affected Components** | Output generation, channel messaging                    |
| **Current Mitigations** | LLM provider content policies                           |
| **Residual Risk**       | Medium - Provider filters imperfect                     |
| **Recommendations**     | Output filtering layer, user controls                   |

---

## 4. ClawHub 공급망 분석

### 4.1 현재 보안 통제

| Control              | Implementation              | Effectiveness                                        |
| -------------------- | --------------------------- | ---------------------------------------------------- |
| GitHub Account Age   | `requireGitHubAccountAge()` | Medium - Raises bar for new attackers                |
| Path Sanitization    | `sanitizePath()`            | High - Prevents path traversal                       |
| File Type Validation | `isTextFile()`              | Medium - Only text files, but can still be malicious |
| Size Limits          | 50MB total bundle           | High - Prevents resource exhaustion                  |
| Required SKILL.md    | Mandatory readme            | Low security value - Informational only              |
| Pattern Moderation   | FLAG_RULES in moderation.ts | Low - Easily bypassed                                |
| Moderation Status    | `moderationStatus` field    | Medium - Manual review possible                      |

### 4.2 중재 플래그 패턴

현재 패턴 `moderation.ts`:

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

**제한사항:**

- 슬러그, 디스플레이 이름, 요약, 서문, 메타데이터, 파일 경로만 확인합니다.
- 실제 스킬코드 내용을 분석하지 않습니다.
- 난독화로 쉽게 우회되는 간단한 정규식
- 행동 분석 없음

### 4.3 개선 계획

| Improvement            | Status                                | Impact                                                                |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| VirusTotal Integration | In Progress                           | High - Code Insight behavioral analysis                               |
| Community Reporting    | Partial (`skillReports` table exists) | Medium                                                                |
| Audit Logging          | Partial (`auditLogs` table exists)    | Medium                                                                |
| Badge System           | Implemented                           | Medium - `highlighted`, `official`, `deprecated`, `redactionApproved` |

---

## 5. 위험 매트릭스

### 5.1 가능성과 영향

| Threat ID     | Likelihood | Impact   | Risk Level   | Priority |
| ------------- | ---------- | -------- | ------------ | -------- |
| T-EXEC-001    | High       | Critical | **Critical** | P0       |
| T-PERSIST-001 | High       | Critical | **Critical** | P0       |
| T-EXFIL-003   | Medium     | Critical | **Critical** | P0       |
| T-IMPACT-001  | Medium     | Critical | **High**     | P1       |
| T-EXEC-002    | High       | High     | **High**     | P1       |
| T-EXEC-004    | Medium     | High     | **High**     | P1       |
| T-ACCESS-003  | Medium     | High     | **High**     | P1       |
| T-EXFIL-001   | Medium     | High     | **High**     | P1       |
| T-IMPACT-002  | High       | Medium   | **High**     | P1       |
| T-EVADE-001   | High       | Medium   | **Medium**   | P2       |
| T-ACCESS-001  | Low        | High     | **Medium**   | P2       |
| T-ACCESS-002  | Low        | High     | **Medium**   | P2       |
| T-PERSIST-002 | Low        | High     | **Medium**   | P2       |

### 5.2 중요 경로 공격 체인

**공격 체인 1: 기술 기반 데이터 도난**

```
T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003
(Publish malicious skill) → (Evade moderation) → (Harvest credentials)
```

**공격 체인 2: RCE에 대한 신속한 주입**

```
T-EXEC-001 → T-EXEC-004 → T-IMPACT-001
(Inject prompt) → (Bypass exec approval) → (Execute commands)
```

**공격 체인 3: 가져온 콘텐츠를 통한 간접 주입**

```
T-EXEC-002 → T-EXFIL-001 → External exfiltration
(Poison URL content) → (Agent fetches & follows instructions) → (Data sent to attacker)
```

---

## 6. 권장 사항 요약

### 6.1 즉시(P0)

| ID    | Recommendation                              | Addresses                  |
| ----- | ------------------------------------------- | -------------------------- |
| R-001 | Complete VirusTotal integration             | T-PERSIST-001, T-EVADE-001 |
| R-002 | Implement skill sandboxing                  | T-PERSIST-001, T-EXFIL-003 |
| R-003 | Add output validation for sensitive actions | T-EXEC-001, T-EXEC-002     |

### 6.2 단기(P1)

| ID    | Recommendation                           | Addresses    |
| ----- | ---------------------------------------- | ------------ |
| R-004 | Implement rate limiting                  | T-IMPACT-002 |
| R-005 | Add token encryption at rest             | T-ACCESS-003 |
| R-006 | Improve exec approval UX and validation  | T-EXEC-004   |
| R-007 | Implement URL allowlisting for web_fetch | T-EXFIL-001  |

### 6.3 중기(P2)

| ID    | Recommendation                                        | Addresses     |
| ----- | ----------------------------------------------------- | ------------- |
| R-008 | Add cryptographic channel verification where possible | T-ACCESS-002  |
| R-009 | Implement config integrity verification               | T-PERSIST-003 |
| R-010 | Add update signing and version pinning                | T-PERSIST-002 |

---

## 7. 부록

### 7.1 ATLAS 기술 매핑

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

### 7.2 주요 보안 파일

| Path                                | Purpose                     | Risk Level   |
| ----------------------------------- | --------------------------- | ------------ |
| `src/infra/exec-approvals.ts`       | Command approval logic      | **Critical** |
| `src/gateway/auth.ts`               | Gateway authentication      | **Critical** |
| `src/web/inbound/access-control.ts` | Channel access control      | **Critical** |
| `src/infra/net/ssrf.ts`             | SSRF protection             | **Critical** |
| `src/security/external-content.ts`  | Prompt injection mitigation | **Critical** |
| `src/agents/sandbox/tool-policy.ts` | Tool policy enforcement     | **Critical** |
| `convex/lib/moderation.ts`          | ClawHub moderation          | **High**     |
| `convex/lib/skillPublish.ts`        | Skill publishing flow       | **High**     |
| `src/routing/resolve-route.ts`      | Session isolation           | **Medium**   |

### 7.3 용어집

| Term                 | Definition                                                |
| -------------------- | --------------------------------------------------------- |
| **ATLAS**            | MITRE's Adversarial Threat Landscape for AI Systems       |
| **ClawHub**          | OpenClaw's skill marketplace                              |
| **Gateway**          | OpenClaw's message routing and authentication layer       |
| **MCP**              | Model Context Protocol - tool provider interface          |
| **Prompt Injection** | Attack where malicious instructions are embedded in input |
| **Skill**            | Downloadable extension for OpenClaw agents                |
| **SSRF**             | Server-Side Request Forgery                               |

---

_이 위협 모델은 살아있는 문서입니다. security@openclaw.ai로 보안 문제를 보고하세요._
