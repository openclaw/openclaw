---
x-i18n:
    generated_at: "2026-02-08T16:05:17Z"
    model: gtx
    provider: google-translate
    source_hash: fd7c528984d1ca5a6ece83d683210d775eca9cd3cc1dc7eadba5516b4adfa854
    source_path: security/CONTRIBUTING-THREAT-MODEL.md
    workflow: 15
---

# OpenClaw 위협 모델에 기여

OpenClaw를 더욱 안전하게 만드는 데 도움을 주셔서 감사합니다. 이 위협 모델은 살아있는 문서이며 우리는 누구의 기여도 환영합니다. 보안 전문가가 될 필요는 없습니다.

## 기여 방법

### 위협 추가

우리가 다루지 않은 공격 벡터나 위험을 발견하셨나요? 다음에서 문제를 엽니다. [오픈클로/신뢰](https://github.com/openclaw/trust/issues) 그리고 자신의 말로 설명해보세요. 프레임워크를 알 필요도 없고 모든 필드를 채울 필요도 없습니다. 시나리오만 설명하면 됩니다.

**포함하면 도움이 됩니다(필수는 아님):**

- 공격 시나리오 및 이를 악용할 수 있는 방법
- OpenClaw의 어느 부분이 영향을 받는지(CLI, 게이트웨이, 채널, ClawHub, MCP 서버 등)
- 얼마나 심각하다고 생각하시나요(낮음/보통/높음/심각)
- 관련 연구, CVE 또는 실제 사례에 대한 링크

검토 중에 ATLAS 매핑, 위협 ID 및 위험 평가를 처리합니다. 이러한 세부 정보를 포함하고 싶다면 좋습니다. 하지만 예상되는 것은 아닙니다.

> **이는 실제 취약점을 보고하는 것이 아니라 위협 모델에 추가하기 위한 것입니다.** 악용 가능한 취약점을 발견한 경우 다음을 참조하세요. [신뢰 페이지](https://trust.openclaw.ai) 책임있는 공개 지침을 위해.

### 완화 제안

기존 위협을 해결하는 방법에 대한 아이디어가 있습니까? 위협을 언급하는 문제나 PR을 엽니다. 유용한 완화는 구체적이고 실행 가능합니다. 예를 들어 "게이트웨이에서 분당 메시지 10개로 발신자당 속도 제한"이 "속도 제한 구현"보다 낫습니다.

### 공격 체인 제안

공격 체인은 여러 위협이 어떻게 현실적인 공격 시나리오로 결합되는지 보여줍니다. 위험한 조합을 발견하면 단계와 공격자가 이를 어떻게 연결하는지 설명하십시오. 실제로 공격이 어떻게 전개되는지에 대한 간략한 설명은 공식적인 템플릿보다 더 가치가 있습니다.

### 기존 콘텐츠 수정 또는 개선

오타, 설명, 오래된 정보, 더 나은 예 - PR을 환영하며 문제가 필요하지 않습니다.

## 우리가 사용하는 것

### 마이터 아틀라스

이 위협 모델은 다음을 기반으로 합니다. [마이터 아틀라스](https://atlas.mitre.org/) (AI 시스템을 위한 적대적 위협 환경)은 신속한 주입, 도구 오용, 에이전트 악용과 같은 AI/ML 위협을 위해 특별히 설계된 프레임워크입니다. 기여하기 위해 ATLAS를 알 필요는 없습니다. 검토 중에 제출물을 프레임워크에 매핑합니다.

### 위협 ID

각 위협은 다음과 같은 ID를 갖습니다. `T-EXEC-003`. 카테고리는 다음과 같습니다:

| Code    | Category                                   |
| ------- | ------------------------------------------ |
| RECON   | Reconnaissance - information gathering     |
| ACCESS  | Initial access - gaining entry             |
| EXEC    | Execution - running malicious actions      |
| PERSIST | Persistence - maintaining access           |
| EVADE   | Defense evasion - avoiding detection       |
| DISC    | Discovery - learning about the environment |
| EXFIL   | Exfiltration - stealing data               |
| IMPACT  | Impact - damage or disruption              |

검토 중에 관리자가 ID를 할당합니다. 하나를 선택할 필요가 없습니다.

### 위험 수준

| Level        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| **Critical** | Full system compromise, or high likelihood + critical impact      |
| **High**     | Significant damage likely, or medium likelihood + critical impact |
| **Medium**   | Moderate risk, or low likelihood + high impact                    |
| **Low**      | Unlikely and limited impact                                       |

위험 수준이 확실하지 않은 경우 영향을 설명하면 평가해 드리겠습니다.

## 검토 과정

1. **분류** - 우리는 48시간 이내에 새로운 제출물을 검토합니다.
2. **평가** - 타당성 검증, ATLAS 매핑 및 위협 ID 할당, 위험 수준 검증
3. **선적 서류 비치** - 모든 것이 형식화되고 완료되었는지 확인합니다.
4. **병합** - 위협 모델 및 시각화에 추가되었습니다.

## 자원

- [아틀라스 웹사이트](https://atlas.mitre.org/)
- [아틀라스 기술](https://atlas.mitre.org/techniques/)
- [ATLAS 사례 연구](https://atlas.mitre.org/studies/)
- [OpenClaw 위협 모델](./THREAT-MODEL-ATLAS.md)

## 연락하다

- **보안 취약점:** 우리를 참조하십시오 [신뢰 페이지](https://trust.openclaw.ai) 보고 지침에 대해
- **위협 모델 질문:** 다음에서 문제를 엽니다. [오픈클로/신뢰](https://github.com/openclaw/trust/issues)
- **일반 채팅:** 디스코드 #보안 채널

## 인식

위협 모델에 기여한 사람은 위협 모델 승인, 릴리스 노트 및 OpenClaw 보안 명예의 전당에서 상당한 기여를 한 것으로 인정됩니다.
