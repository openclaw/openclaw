---
summary: "명령어 실행 승인, 자동 승인, 거부 패턴"
read_when:
  - 명령어 실행 정책을 설정할 때
title: "명령어 승인"
---

# 명령어 승인

에이전트가 실행하는 명령어에 대한 승인 정책입니다.

## 승인 모드

### 기본 동작

- 안전한 명령어: 자동 실행
- 위험한 명령어: 승인 요청
- 차단된 명령어: 거부

### 승인 요청

위험한 명령어 실행 시:

```
🔒 명령어 승인 필요

다음 명령어를 실행할까요?
> npm install express

[승인] [거부] [항상 허용]
```

## 자동 승인

### 패턴으로 허용

```json5
{
  agents: {
    defaults: {
      exec: {
        autoApprove: [
          "git status",
          "git diff",
          "git log *",
          "npm test",
          "npm run lint",
          "ls *",
          "cat *",
        ],
      },
    },
  },
}
```

### 디렉토리별 허용

```json5
{
  agents: {
    defaults: {
      exec: {
        autoApprove: ["* --help", "*/node_modules/.bin/*"],
        autoApproveIn: ["~/projects/sandbox"],
      },
    },
  },
}
```

## 위험 명령어 차단

### 차단 패턴

```json5
{
  agents: {
    defaults: {
      exec: {
        deny: [
          "rm -rf /",
          "rm -rf /*",
          "sudo rm *",
          "chmod 777 *",
          "> /dev/sda",
          "mkfs *",
          "dd if=*",
        ],
      },
    },
  },
}
```

### 차단 시 메시지

```
⛔ 명령어가 차단되었습니다

> rm -rf /

이 명령어는 보안 정책에 의해 차단되었습니다.
```

## 채널별 정책

### 그룹에서 더 엄격하게

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": {
          exec: {
            autoApprove: [], // 자동 승인 없음
            requireApproval: true, // 모든 명령어 승인 필요
          },
        },
      },
    },
  },
}
```

### DM에서 완화

```json5
{
  channels: {
    telegram: {
      dm: {
        exec: {
          autoApprove: ["*"], // 모든 명령어 자동 승인
        },
      },
    },
  },
}
```

## Elevated (권한 승격)

### sudo 사용

```json5
{
  agents: {
    defaults: {
      tools: {
        elevated: true,
      },
    },
  },
}
```

### elevated 도구 사용

에이전트가 `elevated` 도구로 sudo 명령어 실행:

```
elevated(command: "apt update")
```

### 승인 요청

```
🔐 관리자 권한 필요

다음 명령어를 관리자 권한으로 실행할까요?
> sudo apt update

[승인] [거부]
```

## 타임아웃

### 명령어 타임아웃

```json5
{
  agents: {
    defaults: {
      exec: {
        timeout: 300, // 초
      },
    },
  },
}
```

### 무한 실행 방지

```json5
{
  agents: {
    defaults: {
      exec: {
        maxRuntime: 3600, // 최대 1시간
        killOnTimeout: true,
      },
    },
  },
}
```

## 환경변수

### 환경변수 전달

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

### 환경변수 차단

```json5
{
  agents: {
    defaults: {
      exec: {
        filterEnv: ["API_KEY", "SECRET", "PASSWORD"],
      },
    },
  },
}
```

## 작업 디렉토리

### 기본 작업 디렉토리

```json5
{
  agents: {
    defaults: {
      exec: {
        cwd: "~/.openclaw/workspace",
      },
    },
  },
}
```

### 디렉토리 제한

```json5
{
  agents: {
    defaults: {
      exec: {
        allowedDirs: ["~/projects", "/tmp"],
      },
    },
  },
}
```

## 로깅

### 명령어 로깅

```json5
{
  logging: {
    exec: {
      logCommands: true,
      logOutput: true,
      redactPatterns: ["password", "secret"],
    },
  },
}
```

## 베스트 프랙티스

1. **최소 권한**: 필요한 명령어만 자동 승인
2. **위험 차단**: 위험한 패턴 명시적 차단
3. **그룹 제한**: 그룹 세션에서 더 엄격한 정책
4. **로깅 활성화**: 모든 명령어 실행 로깅
