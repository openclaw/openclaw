---
summary: "OpenClaw 문제 해결 가이드"
read_when:
  - 문제가 발생했을 때
  - 오류를 진단할 때
title: "문제 해결"
---

# 문제 해결 가이드

## 기본 진단

문제가 발생하면 먼저 다음 명령어를 실행하세요:

```bash
openclaw doctor
```

이 명령어는 다음을 확인합니다:

- Gateway 상태
- 채널 연결 상태
- 설정 문제
- 보안 경고

## 채팅 명령어

채팅 내에서 사용 가능한 명령어:

| 명령어                        | 설명                                               |
| ----------------------------- | -------------------------------------------------- |
| `/status`                     | 세션 상태 (모델, 토큰)                             |
| `/new` 또는 `/reset`          | 세션 초기화                                        |
| `/compact`                    | 컨텍스트 압축                                      |
| `/think <level>`              | 사고 레벨 설정 (off/minimal/low/medium/high/xhigh) |
| `/verbose on\|off`            | 상세 모드                                          |
| `/usage off\|tokens\|full`    | 사용량 표시                                        |
| `/restart`                    | Gateway 재시작 (그룹에서는 소유자 전용)            |
| `/activation mention\|always` | 그룹 활성화 모드                                   |

## 일반적인 문제

### Gateway가 시작되지 않음

**증상:** `openclaw gateway` 실행 시 오류 발생

**해결 방법:**

1. Node 버전 확인:

```bash
node --version
# v22.12.0 이상이어야 함
```

2. 포트 사용 확인:

```bash
netstat -an | grep 18789
```

3. 로그 확인:

```bash
openclaw logs --follow
```

### 채널 연결 실패

**증상:** 채널이 연결되지 않거나 메시지를 받지 못함

**해결 방법:**

1. 채널 상태 확인:

```bash
openclaw channels status
```

2. 자격 증명 확인:
   - WhatsApp: `openclaw channels login`으로 다시 연결
   - Telegram: 봇 토큰이 올바른지 확인
   - Discord: 봇 토큰과 권한 확인

3. 상세 모드로 Gateway 실행:

```bash
openclaw gateway --verbose
```

### WhatsApp 연결 문제

**증상:** `channels status`가 `linked: false` 표시

**해결 방법:**

```bash
# QR 코드 스캔으로 다시 연결
openclaw channels login

# 상태 확인
openclaw channels status
```

**증상:** 연결되었지만 연결이 끊어짐

```bash
# 진단 실행
openclaw doctor

# Gateway 재시작
openclaw gateway restart
```

### Telegram 봇이 응답하지 않음

**증상:** 봇에 메시지를 보내도 응답 없음

**해결 방법:**

1. 봇 토큰 확인:

```bash
# 토큰이 설정되어 있는지 확인
cat ~/.openclaw/openclaw.json | grep botToken
```

2. API 연결 테스트:

```bash
curl "https://api.telegram.org/bot<token>/getMe"
```

3. 페어링 상태 확인:

```bash
openclaw pairing list telegram
```

4. DM 정책 확인:
   - `dmPolicy`가 `pairing`이면 페어링 코드 승인 필요
   - `dmPolicy`가 `allowlist`이면 `allowFrom`에 사용자 ID 추가 필요

### Discord 슬래시 명령어 문제

**증상:** 슬래시 명령어가 표시되지 않음

**해결 방법:**

- 전역 명령어 등록은 최대 1시간이 걸릴 수 있습니다
- 개발 중에는 특정 길드에 명령어 등록 권장
- 봇에 `applications.commands` 스코프가 있는지 확인

### 메모리/성능 문제

**증상:** Gateway가 느려지거나 메모리 사용량이 높음

**해결 방법:**

1. 컨텍스트 압축:
   - 채팅에서 `/compact` 명령어 사용

2. 세션 정리:

```bash
# 세션 목록 확인
openclaw sessions list

# 오래된 세션 정리
openclaw sessions prune
```

3. 히스토리 제한 설정:

```json5
{
  channels: {
    telegram: {
      historyLimit: 25, // 기본값 50에서 줄임
    },
  },
}
```

### 미디어 전송 실패

**증상:** 이미지나 파일을 보내거나 받을 수 없음

**해결 방법:**

1. 미디어 크기 제한 확인:

```json5
{
  agents: {
    defaults: {
      mediaMaxMb: 5, // 아웃바운드 제한
    },
  },
  channels: {
    whatsapp: {
      mediaMaxMb: 50, // 인바운드 제한
    },
  },
}
```

2. 파일 형식 지원 확인:
   - 이미지: JPEG, PNG, WebP
   - 오디오: OGG/Opus, MP3
   - 문서: PDF, 일반 텍스트

## 로그 확인

### 실시간 로그 보기

```bash
openclaw logs --follow
```

### 로그 파일 위치

- 기본 위치: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Windows: `%TEMP%/openclaw/openclaw-YYYY-MM-DD.log`

### 로그 레벨 설정

```json5
{
  logging: {
    level: "debug", // debug | info | warn | error
  },
}
```

## 네트워크 문제

### IPv6 문제 (Telegram)

**증상:** Telegram 봇이 시작되었다가 조용히 멈춤

**해결 방법:**

- IPv6 이그레스 활성화, 또는
- IPv4 강제 설정:

```json5
{
  channels: {
    telegram: {
      network: {
        autoSelectFamily: false,
      },
    },
  },
}
```

### 프록시 설정

```json5
{
  channels: {
    telegram: {
      proxy: "socks5://localhost:1080",
    },
  },
}
```

## 도움 받기

문제가 해결되지 않으면:

1. [GitHub Issues](https://github.com/openclaw/openclaw/issues)에서 비슷한 문제 검색
2. [Discord 커뮤니티](https://discord.gg/clawd)에서 도움 요청
3. 로그와 설정(민감 정보 제외)을 포함하여 이슈 제출
