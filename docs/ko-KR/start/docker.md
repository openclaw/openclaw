---
summary: "Docker 배포 상세 가이드"
read_when:
  - Docker로 배포할 때
title: "Docker"
---

# Docker

Docker로 OpenClaw를 배포하는 상세 가이드입니다.

## 빠른 시작

```bash
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  -v ~/.openclaw:/root/.openclaw \
  openclaw/openclaw:latest
```

## Docker Compose

### 기본 구성

```yaml
# docker-compose.yml
version: "3.8"
services:
  openclaw:
    image: openclaw/openclaw:latest
    container_name: openclaw
    ports:
      - "18789:18789"
    volumes:
      - ./config:/root/.openclaw
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    restart: unless-stopped
```

```bash
docker compose up -d
```

### 환경변수

```yaml
services:
  openclaw:
    image: openclaw/openclaw:latest
    environment:
      - ANTHROPIC_API_KEY=sk-ant-...
      - OPENAI_API_KEY=sk-...
      - TELEGRAM_BOT_TOKEN=123:abc
      - DISCORD_BOT_TOKEN=...
```

## 볼륨

### 설정 볼륨

```yaml
volumes:
  - ./config:/root/.openclaw
```

### 개별 볼륨

```yaml
volumes:
  - ./config/openclaw.json:/root/.openclaw/openclaw.json
  - ./credentials:/root/.openclaw/credentials
  - ./workspace:/root/.openclaw/workspace
  - openclaw-sessions:/root/.openclaw/sessions

volumes:
  openclaw-sessions:
```

## 네트워크

### Bridge (기본값)

```yaml
services:
  openclaw:
    ports:
      - "18789:18789"
```

### Host

```yaml
services:
  openclaw:
    network_mode: host
```

### Tailscale 사용

```yaml
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: openclaw
    environment:
      - TS_AUTHKEY=${TS_AUTHKEY}
    volumes:
      - tailscale-state:/var/lib/tailscale
    cap_add:
      - NET_ADMIN
      - NET_RAW

  openclaw:
    image: openclaw/openclaw:latest
    network_mode: service:tailscale
    volumes:
      - ./config:/root/.openclaw
    depends_on:
      - tailscale

volumes:
  tailscale-state:
```

## 이미지 태그

| 태그       | 설명      |
| ---------- | --------- |
| `latest`   | 안정 버전 |
| `beta`     | 베타 버전 |
| `dev`      | 개발 버전 |
| `2024.2.0` | 특정 버전 |

## 업데이트

```bash
# 이미지 가져오기
docker compose pull

# 재시작
docker compose up -d
```

## 로그

```bash
# 로그 보기
docker compose logs -f openclaw

# 마지막 100줄
docker compose logs --tail 100 openclaw
```

## 셸 접근

```bash
docker compose exec openclaw sh
```

## 헬스 체크

```yaml
services:
  openclaw:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## 리소스 제한

```yaml
services:
  openclaw:
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 2G
        reservations:
          cpus: "0.5"
          memory: 512M
```

## 커스텀 이미지

### Dockerfile

```dockerfile
FROM openclaw/openclaw:latest

# 추가 패키지
RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# 워크스페이스 복사
COPY workspace /root/.openclaw/workspace
```

### 빌드

```bash
docker build -t my-openclaw .
```

## 문제 해결

### 권한 오류

볼륨 권한 확인:

```bash
chmod -R 755 ./config
```

### 네트워크 문제

```bash
docker network inspect bridge
```

### 로그 확인

```bash
docker compose logs openclaw 2>&1 | grep -i error
```
