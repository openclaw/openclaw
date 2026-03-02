---
summary: "웹 표면 개요: 제어 UI, 웹 채팅, TUI 및 바인드 모드"
read_when:
  - 제어 UI 를 열 때
  - 웹 채팅을 설정할 때
  - 로컬호스트, LAN 또는 Tailnet 액세스를 구성할 때
title: "웹 표면"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: web/index.md
  workflow: 15
---

# 웹 표면

OpenClaw Gateway 는 다음 웹 표면을 제공합니다:

- **Control UI** (`http://localhost:18789`) — 구성, 상태, 로그
- **Web Chat** (`http://localhost:18789/chat`) — 웹 기반 채팅
- **TUI** (`openclaw tui`) — 터미널 사용자 인터페이스

## 바인드 모드

기본값: `loopback` (로컬 액세스만). 옵션:

- `loopback`: 로컬호스트만
- `local`: 로컬 머신 (LAN 피어 액세스)
- `tailnet`: Tailscale Tailnet
- `public`: 모든 인터페이스 (주의: 인증 필수)

## 액세스

```bash
# 로컬호스트
http://127.0.0.1:18789

# SSH 터널을 통해 원격 (권장)
ssh -L 18789:localhost:18789 user@remote-host
http://127.0.0.1:18789

# Tailnet (Tailscale 구성됨)
http://<magicdns>:18789
```

## 관련 문서

- [Gateway 실행 가이드](/ko-KR/gateway)
- [구성](/ko-KR/gateway/configuration)
- [제어 UI](/ko-KR/web/control-ui)
