---
summary: "Bash 및 명령어 실행 도구"
read_when:
  - 명령어 실행을 설정할 때
title: "Bash 도구"
---

# Bash 도구

에이전트가 셸 명령어를 실행하는 도구입니다.

## 기본 사용

에이전트가 명령어 실행:

```
bash(command: "ls -la")
```

## 권한 설정

### 활성화/비활성화

```json5
{
  agents: {
    defaults: {
      tools: {
        bash: true, // 또는 false
      },
    },
  },
}
```

### 승인 필요

```json5
{
  agents: {
    defaults: {
      exec: {
        requireApproval: true,
      },
    },
  },
}
```

## 자동 승인

### 안전한 명령어

```json5
{
  agents: {
    defaults: {
      exec: {
        autoApprove: [
          "ls *",
          "cat *",
          "grep *",
          "find *",
          "git status",
          "git log *",
          "npm test",
          "npm run *",
        ],
      },
    },
  },
}
```

### 패턴 매칭

| 패턴        | 매칭 예시                       |
| ----------- | ------------------------------- |
| `ls *`      | `ls -la`, `ls /tmp`             |
| `git *`     | `git status`, `git log`         |
| `npm run *` | `npm run test`, `npm run build` |

## 거부 목록

### 위험한 명령어 차단

```json5
{
  agents: {
    defaults: {
      exec: {
        deny: [
          "rm -rf *",
          "sudo *",
          "chmod *",
          "chown *",
          "shutdown *",
          "reboot *",
        ],
      },
    },
  },
}
```

## 타임아웃

```json5
{
  agents: {
    defaults: {
      exec: {
        timeout: 60, // 초
      },
    },
  },
}
```

## 작업 디렉토리

### 기본 디렉토리

```json5
{
  agents: {
    defaults: {
      workspace: "~/projects",
    },
  },
}
```

### 명령어에서 지정

```
bash(command: "npm test", cwd: "/project/path")
```

## 환경 변수

### 설정

```json5
{
  agents: {
    defaults: {
      exec: {
        env: {
          NODE_ENV: "development",
          DEBUG: "true",
        },
      },
    },
  },
}
```

### 민감 정보 숨김

```json5
{
  agents: {
    defaults: {
      exec: {
        hideEnv: ["API_KEY", "SECRET"],
      },
    },
  },
}
```

## 출력 제한

```json5
{
  agents: {
    defaults: {
      exec: {
        maxOutput: 10000, // 바이트
        truncate: true,
      },
    },
  },
}
```

## 대화형 명령

### NOT 지원

기본적으로 대화형 명령은 지원하지 않음:

- `vim`, `nano` 등 에디터
- 비밀번호 입력 필요 명령
- 실시간 입력 필요 명령

## 보안 모드

### 샌드박스 내 실행

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

## 로깅

```json5
{
  logging: {
    execLog: true,
    execLogPath: "~/.openclaw/logs/exec.log",
  },
}
```

## 문제 해결

### 명령어 거부됨

1. 승인 목록 확인
2. 거부 목록 확인
3. 수동 승인 필요 여부 확인

### 타임아웃

1. 타임아웃 값 증가
2. 명령어가 완료되는지 확인
