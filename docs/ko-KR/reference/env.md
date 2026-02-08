---
summary: "환경변수 및 시크릿 관리"
read_when:
  - 환경변수를 설정할 때
title: "환경변수"
---

# 환경변수

환경변수 및 시크릿 관리 가이드입니다.

## API 키

### 필수 환경변수

```bash
# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI
export OPENAI_API_KEY="sk-..."

# Google
export GOOGLE_API_KEY="..."
```

## 채널 토큰

```bash
# Telegram
export TELEGRAM_BOT_TOKEN="123456789:ABC..."

# Discord
export DISCORD_BOT_TOKEN="..."

# Slack
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

## 설정 방법

### .env 파일

```bash
# ~/.openclaw/.env
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456789:ABC...
```

### 시스템 환경변수

```bash
# ~/.bashrc 또는 ~/.zshrc
export ANTHROPIC_API_KEY="sk-ant-..."
```

### systemd 서비스

```ini
# /etc/systemd/system/openclaw.service
[Service]
EnvironmentFile=/etc/openclaw/env
```

### Docker

```yaml
# docker-compose.yml
services:
  openclaw:
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    env_file:
      - .env
```

## 설정에서 참조

```json5
{
  channels: {
    telegram: {
      botToken: "$TELEGRAM_BOT_TOKEN",
    },
  },
}
```

## 시크릿 관리

### macOS Keychain

```bash
# 저장
security add-generic-password -s openclaw -a ANTHROPIC_API_KEY -w "sk-ant-..."

# 조회
security find-generic-password -s openclaw -a ANTHROPIC_API_KEY -w
```

### 1Password CLI

```bash
# 참조
export ANTHROPIC_API_KEY=$(op read "op://vault/item/field")
```

## 환경변수 목록

### API 키

| 변수                | 용도          |
| ------------------- | ------------- |
| `ANTHROPIC_API_KEY` | Anthropic API |
| `OPENAI_API_KEY`    | OpenAI API    |
| `GOOGLE_API_KEY`    | Google API    |
| `TOGETHER_API_KEY`  | Together.ai   |
| `GROQ_API_KEY`      | Groq          |

### 채널

| 변수                 | 용도      |
| -------------------- | --------- |
| `TELEGRAM_BOT_TOKEN` | Telegram  |
| `DISCORD_BOT_TOKEN`  | Discord   |
| `SLACK_BOT_TOKEN`    | Slack Bot |
| `SLACK_APP_TOKEN`    | Slack App |

### 기타

| 변수                 | 용도            |
| -------------------- | --------------- |
| `OPENCLAW_CONFIG`    | 설정 파일 경로  |
| `OPENCLAW_DATA_DIR`  | 데이터 디렉토리 |
| `OPENCLAW_LOG_LEVEL` | 로그 레벨       |

## 보안

### .env 보호

```bash
chmod 600 ~/.openclaw/.env
```

### .gitignore

```
# .gitignore
.env
*.secret
credentials/
```

## 문제 해결

### 환경변수 인식 안 됨

1. 셸 재시작
2. `source ~/.bashrc`
3. 변수 이름 오타 확인

### Docker에서 로드 안 됨

1. env_file 경로 확인
2. 파일 권한 확인
