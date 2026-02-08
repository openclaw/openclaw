---
summary: "웹 인터페이스 개요: Control UI, Dashboard, WebChat"
read_when:
  - 웹 UI 사용 시
title: "웹 인터페이스"
---

# 웹 인터페이스

OpenClaw는 브라우저에서 사용할 수 있는 여러 웹 인터페이스를 제공합니다.

## Control UI

Control UI는 OpenClaw의 메인 웹 대시보드입니다. Gateway가 실행 중일 때 브라우저에서 접근할 수 있습니다.

### 접근 방법

```bash
# 대시보드 열기
openclaw dashboard

# 또는 직접 접속
# http://127.0.0.1:18789/
```

### 주요 기능

| 탭           | 설명                                              |
| ------------ | ------------------------------------------------- |
| **Chat**     | WebChat 인터페이스 - 브라우저에서 에이전트와 대화 |
| **Sessions** | 활성 세션 목록 및 관리                            |
| **Channels** | 채널 연결 상태 및 설정                            |
| **Config**   | Gateway 설정 편집                                 |
| **Logs**     | 실시간 로그 뷰어                                  |
| **Nodes**    | 모바일 노드 페어링 및 관리                        |

### 채팅 화면

Control UI의 Chat 탭에서 직접 에이전트와 대화할 수 있습니다:

- 채널 설정 없이 즉시 사용 가능
- 마크다운 렌더링 지원
- 이미지/파일 첨부 가능
- 세션 관리 (초기화, 내보내기)

### 세션 관리

Sessions 탭에서:

- 모든 활성 세션 조회
- 세션별 메시지 히스토리 확인
- 세션 초기화 및 삭제
- 세션 내보내기

## Dashboard

Dashboard는 간소화된 빠른 접근 인터페이스입니다.

```bash
openclaw dashboard
```

표시 정보:

- Gateway 상태
- 연결된 채널
- 최근 활동
- 빠른 링크

## WebChat

WebChat은 독립 실행형 채팅 인터페이스입니다.

### 특징

- 가벼운 단일 페이지 채팅
- 임베드 가능
- 모바일 최적화
- 다크/라이트 모드

### 접근

```
http://127.0.0.1:18789/chat
```

## 인증

### 비밀번호 인증

웹 UI 접근에 비밀번호가 필요하도록 설정:

```json5
{
  gateway: {
    auth: {
      mode: "password",
      password: "your_secure_password",
    },
  },
}
```

### Tailscale 인증

Tailscale 사용 시 추가 인증 우회 가능:

```json5
{
  gateway: {
    auth: {
      mode: "password",
      allowTailscale: true,
    },
  },
}
```

## 원격 접근

### Tailscale Serve

tailnet 내에서만 접근:

```json5
{
  gateway: {
    tailscale: {
      mode: "serve",
    },
  },
}
```

### Tailscale Funnel

공개 HTTPS 접근 (비밀번호 필수):

```json5
{
  gateway: {
    tailscale: {
      mode: "funnel",
    },
    auth: {
      mode: "password",
      password: "strong_password",
    },
  },
}
```

## 문제 해결

### UI가 로드되지 않음

1. Gateway가 실행 중인지 확인:

```bash
openclaw gateway status
```

2. 포트 확인:

```bash
# 기본 포트: 18789
curl http://127.0.0.1:18789/health
```

### 인증 실패

- 비밀번호가 올바른지 확인
- 브라우저 캐시 삭제 후 재시도
