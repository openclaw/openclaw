---
summary: "커스텀 스킬 생성, 구조, 배포 방법"
read_when:
  - 에이전트에게 새로운 기능을 추가하고 싶을 때
  - 스킬을 만들어 공유하고 싶을 때
title: "스킬 만들기"
---

# 스킬 만들기

스킬은 에이전트에게 새로운 능력을 부여하는 확장 단위입니다. `SKILL.md` 파일과 선택적 스크립트/리소스로 구성됩니다.

## 스킬이란?

스킬은 에이전트가 특정 작업을 수행할 수 있도록 지침과 도구를 제공하는 디렉토리입니다. 예를 들어:

- **weather**: 날씨 조회
- **github**: GitHub 이슈/PR 관리
- **spotify**: 음악 재생 제어
- **translate**: 번역 도구

## 빠른 시작

### 1. 디렉토리 생성

```bash
mkdir -p ~/.openclaw/workspace/skills/my-skill
```

### 2. SKILL.md 작성

```markdown
---
name: my-skill
description: "나만의 커스텀 스킬"
tools: ["bash"]
---

# My Skill

이 스킬은 사용자 요청에 따라 특정 작업을 수행합니다.

## 사용 가능한 명령

- `상태 확인`: 시스템 상태를 확인합니다
- `보고서 생성`: 일일 보고서를 생성합니다

## 실행 규칙

- bash 도구를 사용하여 명령을 실행합니다
- 결과를 사용자 친화적으로 포맷합니다
```

### 3. 확인

에이전트에게 "my-skill 사용해서 상태 확인해줘"라고 요청합니다.

## SKILL.md 구조

### 프론트매터 (YAML)

```yaml
---
name: weather               # 스킬 이름 (필수)
description: "날씨 조회"     # 한 줄 설명 (필수)
tools: ["bash", "browser"]  # 필요한 도구 (선택)
env:                         # 환경변수 (선택)
  - WEATHER_API_KEY
---
```

### 본문

마크다운으로 에이전트에게 전달할 지침을 작성합니다. 에이전트가 스킬을 사용할 때 이 내용을 읽습니다.

## 스킬 디렉토리 구조

```
~/.openclaw/workspace/skills/
└── weather/
    ├── SKILL.md              # 지침 파일 (필수)
    ├── scripts/              # 보조 스크립트 (선택)
    │   └── fetch-weather.sh
    ├── templates/            # 템플릿 파일 (선택)
    │   └── report.md
    └── data/                 # 데이터 파일 (선택)
        └── cities.json
```

## 스킬 설정

### 스킬별 환경변수

```json5
{
  skills: {
    entries: {
      weather: {
        enabled: true,
        env: {
          WEATHER_API_KEY: "your-api-key",
        },
      },
    },
  },
}
```

### 스킬 허용 목록

```json5
{
  skills: {
    allowBundled: ["weather", "github"],  // 번들 스킬 허용 목록
  },
}
```

### 추가 스킬 디렉토리

```json5
{
  skills: {
    load: {
      extraDirs: ["~/my-skills"],  // 추가 스킬 디렉토리
    },
  },
}
```

## 실전 예시: GitHub 알림 스킬

```markdown
---
name: github-notify
description: "GitHub 알림 확인 및 요약"
tools: ["bash"]
env:
  - GITHUB_TOKEN
---

# GitHub 알림 스킬

## 기능

사용자가 요청하면 GitHub 알림을 확인하고 요약합니다.

## 실행 방법

1. `gh` CLI를 사용하여 알림을 조회합니다
2. 중요도순으로 정렬합니다
3. 간결한 요약을 작성합니다

## 명령

\`\`\`bash
# 알림 목록
gh api notifications --jq '.[] | {title: .subject.title, type: .subject.type, reason: .reason}'

# 읽지 않은 알림 수
gh api notifications --jq 'length'
\`\`\`
```

## 베스트 프랙티스

### 지침 작성

- **간결하게**: 에이전트에게 필요한 최소한의 정보만 제공
- **구체적으로**: 모호한 지침보다 구체적인 단계 제공
- **안전하게**: bash 실행 시 주의사항 명시

### 보안

- API 키는 환경변수로 관리 (`env` 필드)
- 위험한 명령어 실행 전 확인 지침 포함
- 민감한 정보를 스킬 파일에 하드코딩하지 않기

### 테스트

1. 에이전트에게 스킬 사용을 요청
2. 다양한 시나리오로 테스트
3. 오류 처리 확인

## ClawHub에서 스킬 찾기

커뮤니티 스킬을 검색하고 설치할 수 있습니다:

```bash
openclaw skill list          # 설치된 스킬 목록
openclaw skill search        # ClawHub에서 검색
```

## 다음 단계

- [도구 개요](/ko-KR/tools) - 에이전트 도구 시스템
- [플러그인](/ko-KR/tools/plugins) - 플러그인 설치와 관리
- [실행 승인](/ko-KR/tools/exec-approvals) - 명령어 실행 승인 정책
