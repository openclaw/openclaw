---
summary: "WebChat 임베딩 및 커스터마이징"
read_when:
  - WebChat을 임베딩할 때
title: "WebChat"
---

# WebChat

웹사이트에 임베딩할 수 있는 채팅 위젯입니다.

## 기능

- 웹사이트 임베딩
- 커스텀 스타일링
- 세션 관리
- 멀티 테넌트

## 빠른 시작

### 스크립트 추가

```html
<script src="https://your-gateway.com/webchat.js"></script>
<script>
  OpenClawChat.init({
    gatewayUrl: "https://your-gateway.com",
    position: "bottom-right",
  });
</script>
```

## 설정 옵션

### 기본 설정

```javascript
OpenClawChat.init({
  gatewayUrl: "https://your-gateway.com",
  position: "bottom-right", // bottom-right | bottom-left
  theme: "light", // light | dark | auto
  title: "AI 어시스턴트",
  placeholder: "메시지를 입력하세요...",
});
```

### 스타일링

```javascript
OpenClawChat.init({
  gatewayUrl: "https://...",
  styles: {
    primaryColor: "#007bff",
    borderRadius: "12px",
    fontFamily: "Pretendard, sans-serif",
  },
});
```

### 크기

```javascript
OpenClawChat.init({
  size: {
    width: "380px",
    height: "520px",
  },
  buttonSize: "60px",
});
```

## 인증

### 익명

```javascript
OpenClawChat.init({
  auth: {
    mode: "anonymous",
  },
});
```

### 토큰 기반

```javascript
OpenClawChat.init({
  auth: {
    mode: "token",
    token: "user-specific-token",
  },
});
```

### 세션 ID

```javascript
OpenClawChat.init({
  session: {
    id: "user-123", // 사용자별 세션
    persist: true, // 새로고침 후에도 유지
  },
});
```

## Gateway 설정

```json5
{
  webchat: {
    enabled: true,
    cors: {
      origins: ["https://your-website.com"],
    },
    rateLimit: {
      messages: 10,
      window: 60, // 초
    },
  },
}
```

## 이벤트

```javascript
OpenClawChat.on("open", () => {
  console.log("Chat opened");
});

OpenClawChat.on("message", (msg) => {
  console.log("Message:", msg);
});

OpenClawChat.on("close", () => {
  console.log("Chat closed");
});
```

## 프로그래밍 제어

```javascript
// 열기/닫기
OpenClawChat.open();
OpenClawChat.close();
OpenClawChat.toggle();

// 메시지 전송
OpenClawChat.send("안녕하세요");

// 리셋
OpenClawChat.reset();
```

## 다국어

```javascript
OpenClawChat.init({
  locale: "ko",
  messages: {
    title: "AI 어시스턴트",
    placeholder: "메시지 입력...",
    send: "전송",
    typing: "입력 중...",
  },
});
```

## 파일 업로드

```javascript
OpenClawChat.init({
  features: {
    fileUpload: true,
    imageUpload: true,
    maxFileSize: "10mb",
  },
});
```

## 문제 해결

### CORS 오류

Gateway 설정에서 origins 확인

### 연결 안 됨

1. Gateway URL 확인
2. 네트워크 연결 확인
3. 인증 토큰 확인
