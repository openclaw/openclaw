---
summary: "Docker 샌드박스를 통한 에이전트 격리"
read_when:
  - 보안 격리가 필요할 때
title: "샌드박스"
---

# 샌드박스

샌드박스는 에이전트 세션을 격리된 Docker 환경에서 실행합니다.

## 왜 샌드박스인가?

- **보안**: 신뢰할 수 없는 세션 격리
- **격리**: 세션 간 간섭 방지
- **제한**: 도구 및 리소스 제한

## 샌드박스 모드

### non-main (권장)

비-메인 세션(그룹, 채널)만 샌드박스:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
      },
    },
  },
}
```

### all

모든 세션을 샌드박스:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
      },
    },
  },
}
```

### off

샌드박스 비활성화:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "off",
      },
    },
  },
}
```

## 도구 제한

### 기본 허용 도구

샌드박스에서 허용되는 도구:

- `bash`
- `process`
- `read`
- `write`
- `edit`
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

### 기본 차단 도구

샌드박스에서 차단되는 도구:

- `browser`
- `canvas`
- `nodes`
- `cron`
- `discord`
- `gateway`

### 커스텀 제한

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        tools: {
          allow: ["read", "write", "bash"],
          deny: ["browser", "canvas", "elevated"],
        },
      },
    },
  },
}
```

## Docker 설정

### 기본 이미지

```json5
{
  agents: {
    defaults: {
      sandbox: {
        baseImage: "openclaw/sandbox:latest",
      },
    },
  },
}
```

### 커스텀 이미지

```json5
{
  agents: {
    defaults: {
      sandbox: {
        baseImage: "my-custom-sandbox:v1",
      },
    },
  },
}
```

### 리소스 제한

```json5
{
  agents: {
    defaults: {
      sandbox: {
        resources: {
          memory: "512m",
          cpus: "1",
          timeout: 300,
        },
      },
    },
  },
}
```

## 네트워크 격리

### 네트워크 비활성화

```json5
{
  agents: {
    defaults: {
      sandbox: {
        network: false,
      },
    },
  },
}
```

### 제한된 네트워크

```json5
{
  agents: {
    defaults: {
      sandbox: {
        network: {
          allowlist: ["api.example.com", "cdn.example.com"],
        },
      },
    },
  },
}
```

## 파일 시스템 격리

### 읽기 전용 마운트

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mounts: [
          {
            source: "~/projects",
            target: "/workspace",
            readonly: true,
          },
        ],
      },
    },
  },
}
```

### 임시 작업 디렉토리

```json5
{
  agents: {
    defaults: {
      sandbox: {
        tmpDir: {
          size: "100m",
          persist: false,
        },
      },
    },
  },
}
```

## 샌드박스 관리

### 상태 확인

```bash
openclaw sandbox status
```

### 샌드박스 정리

```bash
# 모든 샌드박스 정리
openclaw sandbox cleanup

# 특정 세션 샌드박스
openclaw sandbox cleanup --session <session-key>
```

### 로그 확인

```bash
openclaw sandbox logs <session-key>
```

## 도구 정책과의 비교

| 기능      | 샌드박스        | 도구 정책     | Elevated  |
| --------- | --------------- | ------------- | --------- |
| 격리 방식 | Docker 컨테이너 | 도구 비활성화 | 권한 승격 |
| 성능 영향 | 있음            | 없음          | 없음      |
| 보안 수준 | 높음            | 중간          | 낮음      |

## 문제 해결

### Docker가 설치되지 않음

```
Error: Docker not found
```

Docker Desktop 또는 Docker Engine 설치 필요.

### 이미지 풀 실패

```bash
docker pull openclaw/sandbox:latest
```

### 권한 오류

Linux에서:

```bash
sudo usermod -aG docker $USER
# 로그아웃 후 다시 로그인
```

### 샌드박스가 느림

1. Docker 리소스 할당 확인
2. 불필요한 컨테이너 정리
3. 리소스 제한 조정
