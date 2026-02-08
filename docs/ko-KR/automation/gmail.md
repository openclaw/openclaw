---
summary: "Gmail 통합 설정"
read_when:
  - Gmail 연동을 설정할 때
title: "Gmail"
---

# Gmail 통합

Gmail을 통해 이메일을 자동으로 처리할 수 있습니다.

## 기능

- 새 이메일 수신 시 에이전트 호출
- 이메일 내용 분석
- 자동 응답 또는 알림

## 설정

### 1. Google Cloud 설정

1. [Google Cloud Console](https://console.cloud.google.com)에서 프로젝트 생성
2. Gmail API 활성화
3. OAuth 자격 증명 생성

### 2. 자격 증명 다운로드

`credentials.json`을 다운로드하여:

```
~/.openclaw/credentials/gmail-credentials.json
```

### 3. OpenClaw 설정

```json5
{
  gmail: {
    enabled: true,
    credentials: "~/.openclaw/credentials/gmail-credentials.json",
    pollInterval: 60, // 초
  },
}
```

### 4. 인증

```bash
openclaw gmail auth
```

브라우저에서 Google 계정으로 로그인하여 권한 부여

## 이메일 처리

### 트리거 설정

```json5
{
  gmail: {
    triggers: [
      {
        match: {
          from: "*@important.com",
        },
        prompt: "이 이메일을 요약하고 대응 방안을 제안해줘",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    ],
  },
}
```

### 매칭 조건

```json5
{
  match: {
    from: "*@example.com", // 발신자
    to: "me@gmail.com", // 수신자
    subject: "*urgent*", // 제목
    hasAttachment: true, // 첨부파일
    labels: ["INBOX", "UNREAD"], // 라벨
  },
}
```

## 자동 응답

### 설정

```json5
{
  gmail: {
    triggers: [
      {
        match: { subject: "*support*" },
        prompt: "이 지원 요청에 대한 초안 응답을 작성해줘",
        action: "draft", // draft | reply | forward
      },
    ],
  },
}
```

### 액션 유형

| 액션      | 설명                 |
| --------- | -------------------- |
| `notify`  | 알림만 전송 (기본값) |
| `draft`   | 초안 작성            |
| `reply`   | 자동 답장            |
| `forward` | 전달                 |
| `label`   | 라벨 추가            |
| `archive` | 보관                 |

## 폴링 설정

```json5
{
  gmail: {
    pollInterval: 30, // 초
    maxResults: 10, // 한 번에 처리할 이메일 수
    markAsRead: false, // 읽음 처리
  },
}
```

## 라벨 관리

### 자동 라벨링

```json5
{
  gmail: {
    triggers: [
      {
        match: { from: "*@work.com" },
        action: "label",
        label: "Work/Processed",
      },
    ],
  },
}
```

## 첨부파일 처리

```json5
{
  gmail: {
    attachments: {
      download: true,
      maxSize: "10mb",
      types: ["pdf", "docx", "txt"],
      analyze: true, // 에이전트가 분석
    },
  },
}
```

## 보안

### 권한 범위

요청되는 권한:

- `gmail.readonly` - 이메일 읽기
- `gmail.send` - 이메일 전송 (자동 응답 시)
- `gmail.modify` - 라벨/읽음 상태 변경

### 민감 정보 처리

```json5
{
  gmail: {
    privacy: {
      redactPatterns: ["password", "secret"],
      excludeAttachments: ["*.key", "*.pem"],
    },
  },
}
```

## 문제 해결

### 인증 오류

1. 자격 증명 파일 확인
2. 재인증: `openclaw gmail auth --force`
3. Google Cloud 콘솔에서 API 상태 확인

### 이메일 수신 안 됨

1. 폴링 간격 확인
2. 매칭 조건 확인
3. 라벨 필터 확인

### 할당량 초과

- Gmail API 일일 할당량 확인
- 폴링 간격 늘리기
