---
summary: "파일 시스템 도구 사용 가이드"
read_when:
  - 파일 도구를 사용할 때
title: "파일 도구"
---

# 파일 도구

에이전트가 파일 시스템을 다루는 도구 가이드입니다.

## 기본 도구

### read

파일 읽기:

```
read(path: "/path/to/file.txt")
```

### write

파일 쓰기:

```
write(path: "/path/to/file.txt", content: "내용")
```

### edit

파일 편집:

```
edit(path: "/path/to/file.txt", changes: [...])
```

### list

디렉토리 목록:

```
list(path: "/path/to/directory")
```

## 검색 도구

### search

파일 내용 검색:

```
search(query: "TODO", path: "/project")
```

### find

파일 찾기:

```
find(pattern: "*.ts", path: "/project")
```

## 권한 설정

### 기본 허용

```json5
{
  agents: {
    defaults: {
      tools: {
        read: true,
        write: true,
        list: true,
      },
    },
  },
}
```

### 읽기 전용

```json5
{
  agents: {
    defaults: {
      tools: {
        read: true,
        write: false,
        edit: false,
      },
    },
  },
}
```

## 경로 제한

### 허용된 경로만

```json5
{
  agents: {
    defaults: {
      filesystem: {
        allowedPaths: ["~/projects", "~/documents"],
        deniedPaths: ["~/.ssh", "~/.config"],
      },
    },
  },
}
```

### 워크스페이스 외부 차단

```json5
{
  agents: {
    defaults: {
      filesystem: {
        restrictToWorkspace: true,
      },
    },
  },
}
```

## 쓰기 승인

### 승인 필요

```json5
{
  agents: {
    defaults: {
      tools: {
        write: {
          requireApproval: true,
        },
      },
    },
  },
}
```

### 자동 승인

```json5
{
  agents: {
    defaults: {
      tools: {
        write: {
          autoApprove: ["*.md", "*.txt", "/tmp/*"],
        },
      },
    },
  },
}
```

## 백업

### 자동 백업

```json5
{
  agents: {
    defaults: {
      filesystem: {
        backup: {
          enabled: true,
          path: "~/.openclaw/backups/files",
        },
      },
    },
  },
}
```

## 파일 크기 제한

```json5
{
  agents: {
    defaults: {
      filesystem: {
        maxFileSize: "10mb",
        maxReadSize: "1mb",
      },
    },
  },
}
```

## Git 통합

### 상태 표시

에이전트가 Git 상태 인식:

```
git_status(path: "/project")
```

### 커밋

```
git_commit(message: "Fix bug", files: ["src/index.ts"])
```

### 설정

```json5
{
  agents: {
    defaults: {
      tools: {
        git: true,
      },
    },
  },
}
```

## 문제 해결

### 권한 오류

1. 경로 허용 목록 확인
2. 파일 시스템 권한 확인

### 파일 찾을 수 없음

1. 상대 경로 대신 절대 경로 사용
2. 워크스페이스 기준 확인
