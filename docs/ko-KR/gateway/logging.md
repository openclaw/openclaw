---
summary: "로깅 설정 및 디버깅"
read_when:
  - 로그를 확인하고 싶을 때
title: "로깅"
---

# 로깅

OpenClaw의 로깅 시스템을 설정하고 활용하는 방법입니다.

## 로그 확인

### CLI로 보기

```bash
# 최근 로그
openclaw logs

# 실시간 로그
openclaw logs --follow

# 특정 필터
openclaw logs --filter telegram
openclaw logs --filter error
```

### 로그 파일 위치

| 플랫폼      | 위치                                      |
| ----------- | ----------------------------------------- |
| Linux/macOS | `/tmp/openclaw/openclaw-YYYY-MM-DD.log`   |
| Windows     | `%TEMP%/openclaw/openclaw-YYYY-MM-DD.log` |

## 로그 레벨

| 레벨    | 설명               |
| ------- | ------------------ |
| `debug` | 모든 세부 정보     |
| `info`  | 일반 정보 (기본값) |
| `warn`  | 경고만             |
| `error` | 오류만             |

### 레벨 설정

```json5
{
  logging: {
    level: "debug",
  },
}
```

### 런타임 변경

```bash
openclaw config set logging.level debug
```

## 채널별 로깅

특정 채널의 로그만 상세히:

```json5
{
  logging: {
    channels: {
      telegram: "debug",
      whatsapp: "info",
    },
  },
}
```

## 로그 출력

### 콘솔 출력

```json5
{
  logging: {
    console: {
      enabled: true,
      colors: true,
    },
  },
}
```

### 파일 출력

```json5
{
  logging: {
    file: {
      enabled: true,
      path: "~/.openclaw/logs/openclaw.log",
      maxSize: "10m",
      maxFiles: 5,
    },
  },
}
```

### JSON 형식

```json5
{
  logging: {
    format: "json",
  },
}
```

## 디버그 모드

### Gateway 상세 모드

```bash
openclaw gateway --verbose
```

### 특정 컴포넌트 디버깅

```json5
{
  logging: {
    debug: {
      agent: true,
      channels: true,
      sessions: true,
    },
  },
}
```

## 채팅에서 디버깅

### 상세 모드 활성화

```
/verbose on
```

### 프롬프트 확인

```
/debug prompt
```

### 세션 정보

```
/status
```

## 로그 분석

### 오류 필터링

```bash
openclaw logs --level error
```

### 시간 범위

```bash
# 최근 1시간
openclaw logs --since 1h

# 특정 시간 이후
openclaw logs --since "2024-01-01 10:00:00"
```

### 검색

```bash
openclaw logs --grep "timeout"
```

## 진단

### Doctor 명령어

```bash
openclaw doctor
```

확인 항목:

- Gateway 상태
- 채널 연결
- 설정 문제
- 보안 경고

### 상태 확인

```bash
openclaw gateway status
openclaw channels status
openclaw sessions list
```

## 로그 정리

### 수동 정리

```bash
# 오래된 로그 삭제
rm /tmp/openclaw/openclaw-*.log
```

### 자동 정리

```json5
{
  logging: {
    retention: {
      days: 7,
      maxTotalSize: "100m",
    },
  },
}
```

## 원격 로깅

### Syslog

```json5
{
  logging: {
    syslog: {
      enabled: true,
      host: "syslog.example.com",
      port: 514,
    },
  },
}
```

### 커스텀 엔드포인트

```json5
{
  logging: {
    remote: {
      url: "https://logs.example.com/ingest",
      headers: {
        Authorization: "Bearer token",
      },
    },
  },
}
```

## 민감 정보 필터링

로그에서 민감 정보 마스킹:

```json5
{
  logging: {
    redact: ["password", "token", "apiKey", "secret"],
  },
}
```

## 베스트 프랙티스

1. **개발 시 debug**: 문제 해결 시 상세 로그
2. **프로덕션 시 info**: 일반 운영 시
3. **로그 순환**: 디스크 공간 관리
4. **민감 정보 마스킹**: 보안 유지
