---
summary: "에이전트 도구 개요 및 설정 가이드"
read_when:
  - 도구 기능을 이해하고 싶을 때
title: "도구"
---

# 도구 (Tools)

OpenClaw 에이전트는 다양한 도구를 사용하여 작업을 수행합니다.

## 기본 도구

### 파일 시스템 도구

| 도구    | 설명               |
| ------- | ------------------ |
| `read`  | 파일 내용 읽기     |
| `write` | 파일 생성 및 쓰기  |
| `edit`  | 기존 파일 편집     |
| `ls`    | 디렉토리 내용 나열 |
| `glob`  | 패턴으로 파일 검색 |

### 실행 도구

| 도구            | 설명                 |
| --------------- | -------------------- |
| `bash` / `exec` | 쉘 명령어 실행       |
| `process`       | 프로세스 관리        |
| `elevated`      | 관리자 권한으로 실행 |

### 브라우저 도구

```json5
{
  browser: {
    enabled: true,
  },
}
```

브라우저 도구로 할 수 있는 것:

- 웹 페이지 방문 및 읽기
- 스크린샷 캡처
- 폼 입력 및 클릭
- JavaScript 실행

## 스킬 (Skills)

스킬은 재사용 가능한 도구/프롬프트 모음입니다.

### 스킬 생성

`~/.openclaw/workspace/skills/` 디렉토리에 폴더 생성:

```
skills/
└── my-skill/
    └── SKILL.md
```

### SKILL.md 형식

```markdown
---
name: my-skill
description: 스킬 설명
---

# 스킬 지침

이 스킬이 활성화되면 에이전트에게 주입되는 프롬프트입니다.

## 사용 방법

상세한 사용 지침을 작성합니다.
```

### 스킬 활성화/비활성화

채팅에서:

```
/skill enable my-skill
/skill disable my-skill
/skill list
```

### 채널별 스킬 제한

```json5
{
  channels: {
    telegram: {
      groups: {
        "-123456789": {
          skills: ["web-search", "image-gen"], // 이 그룹에서 허용된 스킬만
        },
      },
    },
  },
}
```

## 플러그인

플러그인은 외부 패키지로 설치되는 확장 기능입니다.

### 플러그인 설치

```bash
# npm 패키지로 설치
npm install @openclaw/plugin-example

# 또는 로컬 경로
```

### 플러그인 설정

```json5
{
  plugins: {
    "@openclaw/plugin-example": {
      enabled: true,
      config: {
        // 플러그인별 설정
      },
    },
  },
}
```

## 서브에이전트

에이전트가 다른 에이전트를 호출할 수 있습니다.

### 서브에이전트 설정

```json5
{
  agents: {
    list: [
      { id: "main", model: "anthropic/claude-opus-4-6" },
      { id: "coder", model: "anthropic/claude-opus-4-6" },
    ],
  },
}
```

### 서브에이전트 호출

에이전트가 `dispatch` 도구를 사용하여 다른 에이전트에게 작업 위임:

```
dispatch(agentId: "coder", task: "이 함수를 리팩토링해줘")
```

## 명령어 실행 승인

기본적으로 위험한 명령어는 승인이 필요합니다.

### 자동 승인 패턴

```json5
{
  agents: {
    defaults: {
      exec: {
        autoApprove: ["git status", "git diff", "npm test"],
      },
    },
  },
}
```

### 위험 명령어 차단

```json5
{
  agents: {
    defaults: {
      exec: {
        deny: ["rm -rf /", "sudo rm"],
      },
    },
  },
}
```

## 슬래시 명령어

채팅에서 사용 가능한 내장 명령어:

| 명령어                      | 설명           |
| --------------------------- | -------------- |
| `/status`                   | 세션 상태      |
| `/reset`, `/new`            | 세션 초기화    |
| `/compact`                  | 컨텍스트 압축  |
| `/model`                    | 현재 모델 표시 |
| `/model <name>`             | 모델 변경      |
| `/think <level>`            | 사고 레벨 설정 |
| `/skill list`               | 스킬 목록      |
| `/skill enable <name>`      | 스킬 활성화    |
| `/config get <key>`         | 설정 조회      |
| `/config set <key> <value>` | 설정 변경      |

## 도구 제한

### 샌드박스에서 도구 제한

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        tools: {
          allow: ["read", "write", "bash"],
          deny: ["browser", "canvas"],
        },
      },
    },
  },
}
```

### 채널별 도구 제한

```json5
{
  channels: {
    telegram: {
      actions: {
        reactions: true,
        sticker: false,
      },
    },
  },
}
```
