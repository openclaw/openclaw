---
summary: "폴링 기반 자동화 설정"
read_when:
  - 폴링을 설정할 때
title: "폴링"
---

# 폴링

폴링은 외부 소스를 주기적으로 확인하여 변경 사항을 감지합니다.

## 폴링이란?

- 정기적으로 외부 소스 확인
- 새 데이터 발견 시 에이전트 호출
- 웹훅을 지원하지 않는 서비스에 유용

## 기본 설정

```json5
{
  polling: {
    jobs: [
      {
        id: "rss-news",
        type: "rss",
        url: "https://news.example.com/rss",
        interval: 300, // 초
        prompt: "이 뉴스 요약해줘: {{item.title}}",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    ],
  },
}
```

## 폴링 유형

### RSS/Atom

```json5
{
  type: "rss",
  url: "https://blog.example.com/feed",
  interval: 600,
}
```

### HTTP (REST API)

```json5
{
  type: "http",
  url: "https://api.example.com/data",
  method: "GET",
  headers: {
    Authorization: "Bearer token",
  },
  interval: 60,
  check: {
    field: "updated_at",
    comparison: "newer",
  },
}
```

### 파일 시스템

```json5
{
  type: "file",
  path: "/path/to/watch",
  pattern: "*.log",
  interval: 10,
  trigger: "modified", // created | modified | deleted
}
```

### 커맨드

```json5
{
  type: "command",
  command: "git log -1 --format=%H",
  interval: 60,
  trigger: "changed", // 출력이 변경되면
}
```

## 데이터 변환

### 템플릿 변수

```json5
{
  prompt: `
    새 항목 발견:
    제목: {{item.title}}
    URL: {{item.link}}
    설명: {{item.description}}
  `,
}
```

### JSON 경로

```json5
{
  type: "http",
  url: "https://api.example.com/items",
  extract: {
    items: "$.data.items",
    id: "$.id",
  },
}
```

## 상태 추적

중복 처리 방지:

```json5
{
  polling: {
    jobs: [
      {
        id: "news",
        type: "rss",
        url: "...",
        track: {
          field: "guid", // 중복 확인에 사용할 필드
          storage: "~/.openclaw/polling/news.json",
        },
      },
    ],
  },
}
```

## 필터링

### 조건부 처리

```json5
{
  filter: {
    include: {
      title: "*important*",
    },
    exclude: {
      category: "spam",
    },
  },
}
```

## 에러 처리

### 재시도

```json5
{
  retry: {
    maxAttempts: 3,
    delay: 60,
  },
}
```

### 오류 알림

```json5
{
  onError: {
    notify: {
      channel: "telegram",
      to: "123456789",
    },
    maxNotifications: 3, // 연속 오류 시
  },
}
```

## CLI 관리

```bash
# 폴링 작업 목록
openclaw polling list

# 상태 확인
openclaw polling status

# 수동 실행
openclaw polling run <job-id>

# 비활성화
openclaw polling disable <job-id>
```

## 문제 해결

### 변경 감지 안 됨

1. 추적 필드 확인
2. 비교 로직 확인
3. 필터 조건 확인

### 너무 많은 알림

1. 필터 추가
2. 간격 늘리기
3. 배치 처리 설정
