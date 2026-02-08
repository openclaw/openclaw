---
summary: "다중 Gateway 설정"
read_when:
  - 여러 Gateway를 운영할 때
title: "다중 Gateway"
---

# 다중 Gateway

여러 Gateway 인스턴스를 운영하는 방법입니다.

## 사용 사례

- 가정용 + 사무실용 분리
- 개발/프로덕션 환경 분리
- 지역별 분리
- 채널별 분리

## 기본 설정

### 포트 분리

```bash
# Gateway 1
openclaw gateway --port 18789

# Gateway 2 (다른 설정)
openclaw gateway --port 18790 --config ~/.openclaw/gateway2.json
```

### 설정 파일 분리

```bash
~/.openclaw/
├── openclaw.json         # 기본 Gateway
├── gateway-work.json     # 업무용 Gateway
└── gateway-home.json     # 개인용 Gateway
```

## 채널 분리

### 개인용 Gateway

```json5
// gateway-personal.json
{
  channels: {
    whatsapp: { enabled: true },
    telegram: { enabled: false },
  },
}
```

### 업무용 Gateway

```json5
// gateway-work.json
{
  channels: {
    whatsapp: { enabled: false },
    slack: { enabled: true },
    teams: { enabled: true },
  },
}
```

## 에이전트 분리

### 개인 에이전트

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      workspace: "~/.openclaw/personal-workspace",
    },
  },
}
```

### 업무 에이전트

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      workspace: "~/work/workspace",
      sandbox: {
        mode: "all", // 보안 강화
      },
    },
  },
}
```

## Tailscale 설정

### 각 Gateway별 호스트명

Gateway 1:

```json5
{
  gateway: {
    tailscale: {
      mode: "serve",
      hostname: "openclaw-personal",
    },
  },
}
```

Gateway 2:

```json5
{
  gateway: {
    tailscale: {
      mode: "serve",
      hostname: "openclaw-work",
    },
  },
}
```

## systemd 설정

### 서비스 파일

```bash
# 개인용
sudo cp /etc/systemd/system/openclaw.service /etc/systemd/system/openclaw-personal.service

# 업무용
sudo cp /etc/systemd/system/openclaw.service /etc/systemd/system/openclaw-work.service
```

### 서비스 수정

```ini
# openclaw-work.service
[Service]
ExecStart=/usr/bin/openclaw gateway --config ~/.openclaw/gateway-work.json --port 18790
```

## 문제 해결

### 포트 충돌

- 각 Gateway마다 다른 포트 사용
- Tailscale은 포트 충돌 없이 여러 인스턴스 가능

### 세션 공유

- 현재 Gateway 간 세션 공유는 지원되지 않음
- 각 Gateway는 독립적인 세션 저장소 사용
