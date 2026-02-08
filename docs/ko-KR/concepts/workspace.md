---
summary: "워크스페이스 및 프로젝트 관리"
read_when:
  - 워크스페이스를 설정할 때
title: "워크스페이스"
---

# 워크스페이스

에이전트의 작업 공간 설정입니다.

## 기본 개념

워크스페이스는:

- 에이전트의 파일 접근 기본 위치
- 프로젝트별 컨텍스트 제공
- 보안 경계 역할

## 설정

### 기본 워크스페이스

```json5
{
  agents: {
    defaults: {
      workspace: "~/projects",
    },
  },
}
```

### 에이전트별

```json5
{
  agents: {
    list: [
      {
        id: "main",
        workspace: "~/personal",
      },
      {
        id: "work",
        workspace: "~/work/projects",
      },
    ],
  },
}
```

## 워크스페이스 제한

### 외부 접근 차단

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

### 허용 경로 추가

```json5
{
  agents: {
    defaults: {
      filesystem: {
        allowedPaths: ["~/.config/myapp", "/tmp"],
      },
    },
  },
}
```

## 프로젝트 컨텍스트

### 자동 탐지

```json5
{
  agents: {
    defaults: {
      workspace: {
        autoDetect: true,
        markers: ["package.json", ".git", "Cargo.toml"],
      },
    },
  },
}
```

### CLAUDE.md 지원

워크스페이스에 `CLAUDE.md` 파일이 있으면 에이전트가 자동으로 읽음

## 다중 워크스페이스

### 세션별

```json5
{
  bindings: [
    {
      peer: { kind: "group", channel: "slack", group: "project-a" },
      workspace: "~/projects/project-a",
    },
    {
      peer: { kind: "group", channel: "slack", group: "project-b" },
      workspace: "~/projects/project-b",
    },
  ],
}
```

## Git 통합

### Git 워크스페이스

```json5
{
  agents: {
    defaults: {
      workspace: {
        git: {
          enabled: true,
          autoStatus: true,
        },
      },
    },
  },
}
```

### 브랜치 정보

에이전트가 자동으로 인식:

- 현재 브랜치
- 변경 사항
- 최근 커밋

## 저장 위치

### 워크스페이스 데이터

```
~/.openclaw/workspace/
├── main/
│   ├── context.json
│   └── .agentignore
└── work/
    └── context.json
```

## .agentignore

워크스페이스에서 무시할 파일:

```
# .agentignore
node_modules/
.env
*.secret
build/
dist/
```

## 채팅에서 변경

```
/workspace ~/new/path
```

## 문제 해결

### 파일 접근 거부

1. 워크스페이스 경로 확인
2. restrictToWorkspace 설정 확인
3. allowedPaths 확인

### 프로젝트 인식 안 됨

1. marker 파일 존재 확인
2. autoDetect 설정 확인
