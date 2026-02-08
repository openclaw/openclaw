---
summary: "자주 묻는 질문과 답변"
read_when:
  - 일반적인 질문이 있을 때
title: "FAQ"
---

# FAQ (자주 묻는 질문)

## 일반

### OpenClaw는 무엇인가요?

OpenClaw는 여러분이 자주 사용하는 채팅 앱(WhatsApp, Telegram, Discord, iMessage 등)을 AI 코딩 에이전트와 연결하는 **셀프 호스팅 게이트웨이**입니다. 개인 컴퓨터나 서버에서 실행하여 어디서든 AI 어시스턴트에 접근할 수 있습니다.

### 무료인가요?

OpenClaw 자체는 MIT 라이선스로 완전 무료입니다. 단, AI 모델 사용에 따른 API 비용이 발생할 수 있습니다 (Anthropic, OpenAI 등).

### 어떤 AI 모델을 사용할 수 있나요?

- Anthropic Claude (권장: Claude Opus 4.6)
- OpenAI GPT 시리즈
- Google Gemini
- 로컬 모델 (Ollama 등)
- OpenRouter를 통한 다양한 모델

### 데이터는 어디에 저장되나요?

모든 데이터는 로컬에 저장됩니다:

- 설정: `~/.openclaw/openclaw.json`
- 자격 증명: `~/.openclaw/credentials/`
- 세션: `~/.openclaw/sessions/`
- 워크스페이스: `~/.openclaw/workspace/`

## 설치

### Node 버전은 어떻게 확인하나요?

```bash
node --version
# v22.12.0 이상이어야 합니다
```

### Windows에서 설치가 안 됩니다

Windows에서는 WSL2 사용을 강력히 권장합니다:

1. WSL2 설치
2. Ubuntu 등 배포판 설치
3. WSL 내에서 OpenClaw 설치

### 업데이트는 어떻게 하나요?

```bash
openclaw update
```

## 채널

### WhatsApp 연결이 자꾸 끊어집니다

1. 안정적인 인터넷 연결 확인
2. Gateway 호스트가 계속 실행 중인지 확인
3. `openclaw doctor` 실행
4. 필요시 `openclaw channels login`으로 다시 연결

### Telegram 봇이 메시지를 받지 못합니다

1. 봇 토큰이 올바른지 확인
2. DM 정책 확인 (`dmPolicy: "pairing"`이면 페어링 필요)
3. `openclaw pairing list telegram`으로 대기 중인 요청 확인
4. 그룹에서는 프라이버시 모드 설정 확인 (@BotFather → `/setprivacy`)

### 여러 채널을 동시에 사용할 수 있나요?

네, 하나의 Gateway로 WhatsApp, Telegram, Discord, Slack 등을 동시에 운영할 수 있습니다.

### 페어링 코드는 어떻게 승인하나요?

```bash
openclaw pairing list <channel>    # 대기 중인 요청 확인
openclaw pairing approve <channel> <code>  # 승인
```

## 보안

### 아무나 봇에 메시지를 보낼 수 있나요?

기본적으로 아닙니다. `dmPolicy: "pairing"`이 기본값이므로:

1. 알 수 없는 사용자는 페어링 코드를 받습니다
2. 관리자가 승인해야 대화가 가능합니다

### 그룹에서 봇이 모든 메시지에 응답하면 안 됩니다

기본적으로 그룹에서는 @멘션이 필요합니다. `requireMention: true`가 기본 설정입니다.

### 원격에서 접근하고 싶습니다

Tailscale 사용을 권장합니다:

```json5
{
  gateway: {
    tailscale: { mode: "serve" },
  },
}
```

## 문제 해결

### "Gateway not running" 오류

```bash
# Gateway 상태 확인
openclaw gateway status

# Gateway 시작
openclaw gateway --port 18789
```

### "Channel not linked" 오류

해당 채널에 로그인이 필요합니다:

```bash
openclaw channels login --channel <channel>
```

### 메모리 사용량이 높습니다

1. 컨텍스트 압축: 채팅에서 `/compact` 사용
2. 세션 정리: `openclaw sessions prune`
3. 히스토리 제한 줄이기

### 로그는 어디서 볼 수 있나요?

```bash
# 실시간 로그
openclaw logs --follow

# 로그 파일 위치
# Linux/macOS: /tmp/openclaw/openclaw-YYYY-MM-DD.log
# Windows: %TEMP%/openclaw/openclaw-YYYY-MM-DD.log
```

## 개발

### 기여하고 싶습니다

1. GitHub 저장소 Fork
2. 기능 브랜치 생성
3. 변경사항 커밋
4. PR 제출

자세한 내용: [개발 가이드](/ko-KR/reference/contributing)

### 커스텀 스킬을 만들고 싶습니다

`~/.openclaw/workspace/skills/` 디렉토리에 스킬 폴더를 만들고 `SKILL.md` 파일을 작성하세요.

## 더 많은 도움

- [문제 해결 가이드](/ko-KR/help/troubleshooting)
- [GitHub Issues](https://github.com/openclaw/openclaw/issues)
- [Discord 커뮤니티](https://discord.gg/clawd)
