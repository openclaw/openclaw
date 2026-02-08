---
summary: "OpenClaw 아키텍처 및 핵심 개념"
read_when:
  - 전체 시스템 구조를 이해하고 싶을 때
title: "아키텍처"
---

# 아키텍처

이 문서는 OpenClaw의 전체 아키텍처와 핵심 개념을 설명합니다.

## 시스템 개요

```mermaid
flowchart TB
    subgraph Channels["채널 (메시징 플랫폼)"]
        WA[WhatsApp]
        TG[Telegram]
        DC[Discord]
        SL[Slack]
        IM[iMessage]
    end

    subgraph Gateway["OpenClaw Gateway"]
        Router[라우터]
        Sessions[세션 관리]
        Queue[메시지 큐]
        Config[설정 관리]
    end

    subgraph Agents["에이전트"]
        Main[메인 에이전트]
        Sandbox[샌드박스 에이전트]
    end

    subgraph UI["사용자 인터페이스"]
        CLI[CLI]
        WebUI[Control UI]
        MacApp[macOS 앱]
        MobileNodes[모바일 노드]
    end

    Channels --> Gateway
    Gateway --> Agents
    Gateway <--> UI
    Agents --> Gateway
```

## 핵심 컴포넌트

### 1. Gateway

Gateway는 OpenClaw의 핵심입니다. 모든 메시지 라우팅, 세션 관리, 채널 연결을 담당합니다.

**주요 역할:**

- 채널별 인바운드/아웃바운드 메시지 처리
- 세션 상태 관리
- 에이전트 호출 조정
- 인증 및 접근 제어

### 2. 채널

각 메시징 플랫폼을 위한 어댑터입니다.

| 채널     | 라이브러리 | 연결 방식              |
| -------- | ---------- | ---------------------- |
| WhatsApp | Baileys    | WebSocket (Web)        |
| Telegram | grammY     | Long-polling / Webhook |
| Discord  | discord.js | WebSocket              |
| Slack    | Bolt       | Socket Mode            |

### 3. 에이전트

AI 모델과 상호작용하는 컴포넌트입니다.

**에이전트 기능:**

- AI 모델 호출
- 도구 실행
- 컨텍스트 관리
- 응답 생성

### 4. 세션

사용자별 대화 상태를 관리합니다.

**세션 키 형식:**

```
agent:<agentId>:<channel>:<type>:<identifier>
```

예시:

- DM: `agent:main:telegram:dm:123456789`
- 그룹: `agent:main:whatsapp:group:12345678901@g.us`

## 메시지 흐름

### 인바운드 흐름 (사용자 → 에이전트)

```mermaid
sequenceDiagram
    participant User as 사용자
    participant Channel as 채널
    participant Gateway as Gateway
    participant Agent as 에이전트
    participant AI as AI 모델

    User->>Channel: 메시지 전송
    Channel->>Gateway: 메시지 정규화
    Gateway->>Gateway: 접근 제어 확인
    Gateway->>Agent: 에이전트 호출
    Agent->>AI: 프롬프트 전송
    AI->>Agent: 응답 수신
    Agent->>Gateway: 응답 반환
    Gateway->>Channel: 채널 형식으로 변환
    Channel->>User: 응답 전송
```

### 아웃바운드 흐름 (에이전트 → 사용자)

에이전트가 먼저 메시지를 보내는 경우 (예: 크론 작업, 하트비트):

```mermaid
sequenceDiagram
    participant Cron as 크론 작업
    participant Agent as 에이전트
    participant Gateway as Gateway
    participant Channel as 채널
    participant User as 사용자

    Cron->>Agent: 트리거
    Agent->>Gateway: 메시지 요청
    Gateway->>Channel: 전송
    Channel->>User: 메시지 수신
```

## 멀티 에이전트 라우팅

특정 발신자나 그룹을 다른 에이전트로 라우팅할 수 있습니다.

```json5
{
  agents: {
    list: [
      {
        id: "main",
        model: "anthropic/claude-opus-4-6",
      },
      {
        id: "coding",
        model: "anthropic/claude-opus-4-6",
        workspace: "~/.openclaw/coding",
      },
    ],
  },
  bindings: [
    {
      peer: { kind: "dm", channel: "telegram", sender: "123456789" },
      agent: "coding",
    },
  ],
}
```

## 세션 관리

### 세션 범위

| 범위          | 설명                   |
| ------------- | ---------------------- |
| `per-sender`  | 발신자별 세션 (기본값) |
| `per-channel` | 채널별 단일 세션       |

### 세션 스토어

세션 데이터는 로컬 파일 시스템에 저장됩니다:

```
~/.openclaw/sessions/
├── agent:main:telegram:dm:123456789/
│   ├── history.json
│   └── state.json
└── agent:main:whatsapp:group:abc@g.us/
    ├── history.json
    └── state.json
```

### 세션 명령어

```bash
# 세션 목록
openclaw sessions list

# 세션 히스토리
openclaw sessions history <session-key>

# 세션 초기화
openclaw sessions reset <session-key>
```

## 도구 시스템

에이전트가 사용할 수 있는 도구들입니다.

### 기본 도구

| 도구      | 설명             |
| --------- | ---------------- |
| `bash`    | 쉘 명령어 실행   |
| `read`    | 파일 읽기        |
| `write`   | 파일 쓰기        |
| `edit`    | 파일 편집        |
| `browser` | 웹 브라우저 제어 |

### 채널 도구

| 도구       | 설명               |
| ---------- | ------------------ |
| `message`  | 메시지 전송        |
| `react`    | 리액션 추가        |
| `telegram` | Telegram 특정 액션 |
| `whatsapp` | WhatsApp 특정 액션 |

### 스킬

워크스페이스별로 커스텀 도구를 정의할 수 있습니다:

```
~/.openclaw/workspace/skills/
└── my-skill/
    └── SKILL.md
```

## 샌드박스

비-주 세션(그룹, 채널)은 Docker 샌드박스에서 실행할 수 있습니다.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        baseImage: "openclaw/sandbox:latest",
      },
    },
  },
}
```

### 샌드박스 도구 제한

| 허용                    | 거부              |
| ----------------------- | ----------------- |
| `bash`, `read`, `write` | `browser`         |
| `edit`, `process`       | `canvas`          |
| `sessions_*`            | `cron`, `gateway` |

## 워크스페이스

에이전트가 작업하는 디렉토리입니다.

```
~/.openclaw/workspace/
├── AGENTS.md         # 에이전트 지침
├── SOUL.md           # 성격 정의
├── TOOLS.md          # 도구 사용 지침
├── HEARTBEAT.md      # 하트비트 지침
└── skills/           # 커스텀 스킬
```

## 다음 단계

- [설정 가이드](/ko-KR/gateway/configuration) - 상세 설정 옵션
- [채널 설정](/ko-KR/channels) - 각 채널별 설정
- [보안](/ko-KR/gateway/security) - 보안 설정
