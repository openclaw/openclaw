---
summary: "셸 명령어 실행 도구의 파라미터, 호스트, 보안 설정"
read_when:
  - 에이전트의 명령어 실행 기능을 이해하고 싶을 때
  - 실행 보안 정책을 설정하고 싶을 때
title: "명령어 실행 (Exec)"
---

# 명령어 실행 (Exec)

`exec` (bash) 도구는 에이전트가 셸 명령어를 실행할 수 있게 합니다. 호스트 선택, 보안 모드, 승인 흐름 등을 설정할 수 있습니다.

## 기본 동작

에이전트가 `bash` 도구를 호출하면:

1. 명령어와 인자를 파싱
2. 보안 정책 확인 (허용/거부/승인 필요)
3. 지정된 호스트에서 실행
4. 결과를 에이전트에 반환

## 실행 호스트

| 호스트     | 설명                              | 기본값 |
| ---------- | --------------------------------- | ------ |
| `sandbox`  | Docker 샌드박스 내 실행           | 예     |
| `gateway`  | Gateway 호스트에서 직접 실행      | 아니오 |
| `node`     | 연결된 모바일/원격 노드에서 실행  | 아니오 |

### 샌드박스 (기본)

비-메인 세션은 기본적으로 Docker 샌드박스에서 실행됩니다:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        baseImage: "openclaw/sandbox:latest",
      },
    },
  },
}
```

### Gateway 호스트

메인 세션이나 신뢰할 수 있는 세션은 Gateway에서 직접 실행할 수 있습니다.

### 노드

연결된 iOS/Android/원격 노드에서 명령을 실행합니다.

## 보안 모드

```json5
{
  agents: {
    defaults: {
      tools: {
        exec: {
          security: "allowlist",   // deny, allowlist, full
        },
      },
    },
  },
}
```

| 모드         | 설명                                  |
| ------------ | ------------------------------------- |
| `deny`       | 모든 명령어 실행 거부                 |
| `allowlist`  | 허용된 명령어만 실행 (기본값)         |
| `full`       | 모든 명령어 실행 허용                 |

### 허용 목록 설정

```json5
{
  agents: {
    defaults: {
      tools: {
        exec: {
          security: "allowlist",
          safeBins: [
            "ls", "cat", "grep", "find",
            "git", "npm", "node",
            "python", "pip",
          ],
        },
      },
    },
  },
}
```

## 실행 승인

Gateway/노드에서 실행할 때 사용자 승인이 필요한 경우:

```json5
{
  agents: {
    defaults: {
      tools: {
        exec: {
          approvals: {
            gateway: true,    // Gateway 실행 시 승인 필요
            node: true,       // 노드 실행 시 승인 필요
          },
        },
      },
    },
  },
}
```

승인 요청은 Control UI나 채팅에서 `/approve` 명령으로 처리합니다.

## 파라미터

| 파라미터     | 설명                          | 기본값     |
| ------------ | ----------------------------- | ---------- |
| `command`    | 실행할 명령어                 | (필수)     |
| `workdir`    | 작업 디렉토리                 | 워크스페이스 |
| `env`        | 환경변수                      | `{}`       |
| `timeout`    | 타임아웃 (초)                 | 300        |
| `background` | 백그라운드 실행               | `false`    |
| `host`       | 실행 호스트                   | `sandbox`  |
| `elevated`   | 상승된 권한으로 실행          | `false`    |

## 상승된 권한 (Elevated)

특정 작업에 더 높은 권한이 필요할 때:

```
/elevated on          # 세션에서 상승 모드 활성화
/elevated off         # 비활성화
```

설정:

```json5
{
  agents: {
    defaults: {
      tools: {
        elevated: {
          enabled: true,
          requireApproval: true,  // 승인 필요
        },
      },
    },
  },
}
```

## 백그라운드 실행

장시간 명령어를 백그라운드에서 실행:

```json
{
  "tool": "bash",
  "args": {
    "command": "npm run build",
    "background": true
  }
}
```

에이전트는 프로세스 ID를 받고, 나중에 결과를 확인할 수 있습니다.

## 환경변수와 PATH

### PATH 관리

```json5
{
  agents: {
    defaults: {
      tools: {
        exec: {
          path: [
            "/usr/local/bin",
            "~/.nvm/versions/node/v22/bin",
          ],
        },
      },
    },
  },
}
```

### 환경변수 주입

```json5
{
  agents: {
    defaults: {
      tools: {
        exec: {
          env: {
            NODE_ENV: "development",
          },
        },
      },
    },
  },
}
```

## 문제 해결

| 증상                     | 해결                                          |
| ------------------------ | --------------------------------------------- |
| "Permission denied"      | 보안 모드와 허용 목록 확인                    |
| "Command not found"      | PATH 설정 확인                                |
| "Approval required"      | `/approve`로 승인 또는 승인 정책 변경         |
| 타임아웃                 | `timeout` 값 증가 또는 백그라운드 실행        |

## 다음 단계

- [실행 승인](/ko-KR/tools/exec-approvals) - 승인 정책 상세
- [샌드박싱](/ko-KR/gateway/sandboxing) - Docker 샌드박스 설정
- [도구 개요](/ko-KR/tools) - 사용 가능한 도구 전체
