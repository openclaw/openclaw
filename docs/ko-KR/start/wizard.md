---
summary: "온보딩 마법사 상세 가이드"
read_when:
  - 온보딩 마법사 사용 시
title: "온보딩 마법사"
---

# 온보딩 마법사

`openclaw onboard` 명령어는 OpenClaw 초기 설정을 안내하는 대화형 마법사입니다.

## 기본 사용법

```bash
openclaw onboard
```

서비스 설치와 함께 실행:

```bash
openclaw onboard --install-daemon
```

## 마법사 단계

### 1. API 키 설정

마법사가 AI 모델 provider를 선택하도록 안내합니다.

**Anthropic (권장):**

```
? Select AI provider: Anthropic
? Enter your Anthropic API key: sk-ant-...
```

**OpenAI:**

```
? Select AI provider: OpenAI
? Enter your OpenAI API key: sk-...
```

### 2. Gateway 설정

Gateway 포트와 바인딩 주소를 설정합니다.

```
? Gateway port: 18789
? Bind address: loopback
```

| 옵션       | 설명                         |
| ---------- | ---------------------------- |
| `loopback` | 로컬 전용 (127.0.0.1) - 권장 |
| `lan`      | 로컬 네트워크                |
| `any`      | 모든 인터페이스              |

### 3. 인증 설정

Gateway 접근 인증을 설정합니다.

```
? Enable authentication: Yes
? Set password: ********
```

### 4. 채널 설정 (선택사항)

원하는 채널을 설정합니다.

**WhatsApp:**

```
? Configure WhatsApp: Yes
? Your phone number (for allowlist): +821012345678
? DM policy: pairing
```

**Telegram:**

```
? Configure Telegram: Yes
? Bot token: 123:abc
? Your Telegram user ID (for allowlist): 123456789
```

### 5. 서비스 설치 (선택사항)

시스템 서비스로 설치하여 자동 시작:

```
? Install as system service: Yes
```

## 마법사 옵션

| 옵션                | 설명                        |
| ------------------- | --------------------------- |
| `--install-daemon`  | 시스템 서비스로 설치        |
| `--skip-api-key`    | API 키 설정 건너뛰기        |
| `--skip-channels`   | 채널 설정 건너뛰기          |
| `--non-interactive` | 비대화형 모드 (기본값 사용) |

## 마법사 이후

마법사 완료 후:

1. Gateway 시작 확인:

```bash
openclaw gateway status
```

2. Control UI 열기:

```bash
openclaw dashboard
```

3. 채널 로그인 (WhatsApp 등):

```bash
openclaw channels login
```

## 설정 파일 위치

마법사가 생성하는 파일:

- `~/.openclaw/openclaw.json` - 메인 설정
- `~/.openclaw/credentials/` - 채널 자격 증명

## 설정 재실행

마법사를 다시 실행하면 기존 설정을 업데이트합니다:

```bash
openclaw onboard
```

기존 설정을 유지하면서 추가 채널만 설정하려면:

```bash
openclaw onboard --skip-api-key
```

## 문제 해결

### 마법사가 중단되었습니다

설정 파일을 직접 편집할 수 있습니다:

```bash
openclaw config edit
```

### API 키가 잘못되었습니다

마법사를 다시 실행하거나 설정 파일을 직접 수정:

```bash
openclaw onboard
# 또는
openclaw config set agent.anthropicApiKey "sk-ant-..."
```
