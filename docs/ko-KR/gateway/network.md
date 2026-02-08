---
summary: "네트워크 설정 및 DNS"
read_when:
  - 네트워크를 설정할 때
title: "네트워크"
---

# 네트워크

Gateway의 네트워크 설정입니다.

## 바인딩

### 로컬만

```json5
{
  gateway: {
    bind: "loopback", // 127.0.0.1만
    port: 18789,
  },
}
```

### 모든 인터페이스

```json5
{
  gateway: {
    bind: "all", // 0.0.0.0
    port: 18789,
  },
}
```

### 특정 IP

```json5
{
  gateway: {
    bind: "192.168.1.100",
    port: 18789,
  },
}
```

## 포트

### 기본 포트

- **18789**: Gateway
- **18790**: 예비 (다중 Gateway)

### 변경

```json5
{
  gateway: {
    port: 8080,
  },
}
```

## HTTPS

### 자체 인증서

```json5
{
  gateway: {
    tls: {
      enabled: true,
      cert: "/path/to/cert.pem",
      key: "/path/to/key.pem",
    },
  },
}
```

### Let's Encrypt

```json5
{
  gateway: {
    tls: {
      enabled: true,
      acme: {
        email: "you@example.com",
        domain: "openclaw.example.com",
      },
    },
  },
}
```

## 프록시

### HTTP 프록시

```json5
{
  network: {
    proxy: {
      http: "http://proxy.example.com:8080",
      https: "http://proxy.example.com:8080",
    },
  },
}
```

### 프록시 제외

```json5
{
  network: {
    proxy: {
      noProxy: ["localhost", "127.0.0.1", "*.local"],
    },
  },
}
```

## DNS

### 커스텀 DNS

```json5
{
  network: {
    dns: {
      servers: ["8.8.8.8", "1.1.1.1"],
    },
  },
}
```

## CORS

### 웹 클라이언트용

```json5
{
  gateway: {
    cors: {
      origins: ["https://your-website.com"],
      methods: ["GET", "POST"],
      credentials: true,
    },
  },
}
```

## 방화벽

### 권장 설정

```bash
# UFW
sudo ufw allow ssh
sudo ufw allow 18789/tcp  # Tailscale 사용 시 불필요
sudo ufw enable
```

### iptables

```bash
iptables -A INPUT -p tcp --dport 18789 -j ACCEPT
```

## 연결 제한

### 동시 연결

```json5
{
  gateway: {
    maxConnections: 100,
  },
}
```

### 연결 타임아웃

```json5
{
  gateway: {
    timeout: {
      connection: 30, // 초
      request: 120,
    },
  },
}
```

## 헬스체크

### 엔드포인트

```
GET /health
```

### 응답

```json
{
  "status": "ok",
  "uptime": 3600
}
```

## 문제 해결

### 연결 거부

1. 포트 열려있는지 확인
2. 바인딩 설정 확인
3. 방화벽 규칙 확인

### CORS 오류

1. origins 설정 확인
2. 정확한 도메인 입력
