---
summary: "OpenClaw 시스템 프롬프트에 포함되는 내용과 조립 방식"
read_when:
  - 시스템 프롬프트 텍스트, 도구 목록, 또는 시간/하트비트 섹션을 편집할 때
  - 워크스페이스 부트스트랩 또는 Skills 주입 동작을 변경할 때
title: "시스템 프롬프트"
---

# 시스템 프롬프트

OpenClaw 는 모든 에이전트 실행마다 커스텀 시스템 프롬프트를 빌드합니다. 이 프롬프트는 **OpenClaw 소유**이며 p-coding-agent 기본 프롬프트를 사용하지 않습니다.

프롬프트는 OpenClaw 에 의해 조립되어 각 에이전트 실행에 주입됩니다.

## 구조

프롬프트는 의도적으로 컴팩트하게 설계되었으며 고정된 섹션을 사용합니다:

- **Tooling**: 현재 도구 목록 + 짧은 설명.
- **Safety**: 권력 추구 행동이나 감독 우회를 피하도록 하는 짧은 가드레일 알림.
- **Skills** (사용 가능한 경우): 필요 시 Skills 지침을 로드하는 방법을 모델에 안내합니다.
- **OpenClaw Self-Update**: `config.apply` 과 `update.run` 실행 방법.
- **Workspace**: 작업 디렉토리 (`agents.defaults.workspace`).
- **Documentation**: OpenClaw 문서의 로컬 경로 (repo 또는 npm 패키지)와 언제 읽어야 하는지.
- **Workspace Files (injected)**: 부트스트랩 파일이 아래에 포함되어 있음을 나타냅니다.
- **Sandbox** (활성화된 경우): 샌드박스화된 런타임, 샌드박스 경로, 권한 상승 exec 사용 가능 여부를 나타냅니다.
- **Current Date & Time**: 사용자 로컬 시간, 타임존, 시간 형식.
- **Reply Tags**: 지원되는 프로바이더를 위한 선택적 응답 태그 문법.
- **Heartbeats**: 하트비트 프롬프트 및 ack 동작.
- **Runtime**: 호스트, OS, node, 모델, repo 루트 (감지된 경우), 사고 수준 (한 줄).
- **Reasoning**: 현재 가시성 수준 + /reasoning 토글 힌트.

시스템 프롬프트의 Safety 가드레일은 권고적입니다. 이는 모델 동작을 안내하지만 정책을 강제하지는 않습니다. 강제 적용을 위해서는 도구 정책, exec 승인, 샌드박스화, 채널 허용 목록을 사용하십시오. 운영자는 설계에 따라 이를 비활성화할 수 있습니다.

## 프롬프트 모드

OpenClaw 는 서브 에이전트를 위해 더 작은 시스템 프롬프트를 렌더링할 수 있습니다. 런타임은 각 실행마다
`promptMode` 를 설정합니다 (사용자 노출 설정 아님):

- `full` (기본값): 위의 모든 섹션을 포함합니다.
- `minimal`: 서브 에이전트에 사용되며 **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies**, **Heartbeats** 를 생략합니다. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (알려진 경우), Runtime, 그리고 주입된
  컨텍스트는 계속 사용 가능합니다.
- `none`: 기본 정체성 라인만 반환합니다.

`promptMode=minimal` 인 경우, 추가로 주입된 프롬프트는 **Group Chat Context** 대신
**Subagent Context** 로 라벨링됩니다.

## Workspace 부트스트랩 주입

부트스트랩 파일은 트리밍되어 **Project Context** 아래에 추가되며, 이를 통해 모델이 명시적인 읽기 없이도 정체성과 프로필 컨텍스트를 볼 수 있습니다:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (완전히 새로운 워크스페이스에서만)

대용량 파일은 마커와 함께 잘립니다. 파일당 최대 크기는
`agents.defaults.bootstrapMaxChars` (기본값: 20000) 으로 제어됩니다. 누락된 파일은
짧은 누락 파일 마커를 주입합니다.

내부 훅은 `agent:bootstrap` 를 통해 이 단계를 가로채어 주입된 부트스트랩 파일을 변형하거나 교체할 수 있습니다 (예: `SOUL.md` 를 대체 페르소나로 교체).

각 주입 파일이 얼마나 기여하는지 (원본 대비 주입, 트렁케이션, 도구 스키마 오버헤드 포함)를 확인하려면 `/context list` 또는 `/context detail` 를 사용하십시오. 자세한 내용은 [Context](/concepts/context) 를 참고하십시오.

## 시간 처리

시스템 프롬프트에는 사용자 타임존이 알려진 경우 전용 **Current Date & Time** 섹션이 포함됩니다. 프롬프트 캐시 안정성을 유지하기 위해, 현재는 **타임존** 만 포함하며 (동적 시계나 시간 형식은 포함하지 않음) 구성됩니다.

에이전트가 현재 시간이 필요할 때는 `session_status` 를 사용하십시오. 상태 카드에는 타임스탬프 라인이 포함됩니다.

구성은 다음으로 설정합니다:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

전체 동작에 대한 자세한 내용은 [Date & Time](/date-time) 을 참고하십시오.

## Skills

사용 가능한 Skills 가 존재하면, OpenClaw 는 각 Skill 의 **파일 경로** 를 포함한 컴팩트한 **available skills list**
(`formatSkillsForPrompt`) 를 주입합니다. 프롬프트는 모델이 `read` 를 사용하여 나열된 위치
(워크스페이스, 관리형, 또는 번들) 에 있는 SKILL.md 를 로드하도록 지시합니다. 사용 가능한 Skills 가 없으면
Skills 섹션은 생략됩니다.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

이는 기본 프롬프트를 작게 유지하면서도 타겟팅된 Skill 사용을 가능하게 합니다.

## Documentation

사용 가능한 경우, 시스템 프롬프트에는 로컬 OpenClaw 문서 디렉토리를 가리키는 **Documentation** 섹션이 포함됩니다
(repo 워크스페이스의 `docs/` 또는 번들된 npm 패키지 문서). 또한 공개 미러, 소스 repo, 커뮤니티 Discord, 그리고
Skills 탐색을 위한 ClawHub ([https://clawhub.com](https://clawhub.com)) 도 함께 안내합니다. 프롬프트는 모델에게 OpenClaw 동작, 명령, 구성, 아키텍처에 대해서는 먼저 로컬 문서를 참고하도록 지시하며, 가능할 경우 `openclaw status` 를 직접 실행하도록 안내합니다 (접근 권한이 없을 때만 사용자에게 요청).
