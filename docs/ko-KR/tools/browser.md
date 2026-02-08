---
summary: "브라우저 도구 사용 가이드"
read_when:
  - 브라우저 자동화가 필요할 때
title: "브라우저"
---

# 브라우저

OpenClaw 에이전트는 브라우저를 사용하여 웹 페이지와 상호작용할 수 있습니다.

## 브라우저 활성화

```json5
{
  browser: {
    enabled: true,
  },
}
```

## 기능

### 페이지 방문

에이전트가 URL을 방문하고 내용을 읽습니다:

- HTML 파싱
- 텍스트 추출
- 링크 탐색

### 스크린샷

페이지의 스크린샷을 캡처:

- 전체 페이지
- 특정 영역
- 요소별 캡처

### 상호작용

- 클릭
- 텍스트 입력
- 스크롤
- 폼 제출

### JavaScript 실행

페이지에서 커스텀 JavaScript 실행

## 설정

### 기본 설정

```json5
{
  browser: {
    enabled: true,
    headless: true, // 헤드리스 모드
    timeout: 30000, // 타임아웃 (ms)
    viewport: {
      width: 1280,
      height: 720,
    },
  },
}
```

### 사용자 에이전트

```json5
{
  browser: {
    userAgent: "Mozilla/5.0 ...",
  },
}
```

### 프록시

```json5
{
  browser: {
    proxy: "http://proxy.example.com:8080",
  },
}
```

## 로그인 세션

### 로그인 세션 저장

브라우저 로그인 세션을 저장하여 재사용:

```bash
# 로그인 세션 시작
openclaw browser login

# 브라우저가 열리면 수동으로 로그인
# 완료 후 세션이 저장됨
```

### 세션 관리

```bash
# 저장된 세션 목록
openclaw browser sessions

# 세션 삭제
openclaw browser logout <session-name>
```

## Chrome 확장 프로그램

OpenClaw Chrome 확장 프로그램을 통해 브라우저와 통합:

### 설치

1. Chrome 웹 스토어에서 설치
2. Gateway URL 설정
3. 인증

### 기능

- 현재 페이지를 에이전트와 공유
- 페이지 내용 요약 요청
- 선택한 텍스트에 대해 질문

## 제한사항

### 샌드박스에서 비활성화

샌드박스 모드에서는 브라우저가 기본적으로 비활성화:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        tools: {
          deny: ["browser"],
        },
      },
    },
  },
}
```

### 리소스 제한

- 동시 브라우저 인스턴스 제한
- 메모리 사용량 모니터링 권장
- 장시간 실행 시 브라우저 재시작

## Linux 문제 해결

### 의존성 설치

```bash
# Debian/Ubuntu
sudo apt install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2

# Fedora
sudo dnf install nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib
```

### 디스플레이 문제

헤드리스 서버에서:

```bash
# Xvfb 사용
xvfb-run openclaw gateway
```

### 권한 문제

```bash
# Chrome sandbox 비활성화 (보안 위험)
# 개발 환경에서만 사용
export CHROME_NO_SANDBOX=true
```

## 베스트 프랙티스

1. **헤드리스 모드 사용**: 서버에서는 항상 헤드리스 모드
2. **타임아웃 설정**: 적절한 타임아웃으로 무한 대기 방지
3. **세션 정리**: 사용하지 않는 로그인 세션 정기 삭제
4. **리소스 모니터링**: 메모리 사용량 확인
