---
summary: "MCP 서버 및 통합"
read_when:
  - MCP를 사용할 때
title: "MCP"
---

# MCP (Model Context Protocol)

MCP 서버와의 통합 가이드입니다.

## MCP란?

- 외부 도구/데이터 소스 연결 표준
- 에이전트 기능 확장
- 플러그인 생태계

## MCP 서버 추가

### 설정

```json5
{
  mcp: {
    servers: [
      {
        name: "filesystem",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/allowed/path",
        ],
      },
      {
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: {
          GITHUB_TOKEN: "ghp_...",
        },
      },
    ],
  },
}
```

## 인기 MCP 서버

### 파일 시스템

```json5
{
  name: "filesystem",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "~/documents"],
}
```

### GitHub

```json5
{
  name: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "ghp_..." },
}
```

### Slack

```json5
{
  name: "slack",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-slack"],
  env: { SLACK_BOT_TOKEN: "xoxb-..." },
}
```

### 데이터베이스

```json5
{
  name: "postgres",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-postgres"],
  env: { DATABASE_URL: "postgres://..." },
}
```

## 에이전트별 MCP

```json5
{
  agents: {
    list: [
      {
        id: "developer",
        mcp: ["filesystem", "github"],
      },
      {
        id: "analyst",
        mcp: ["postgres", "slack"],
      },
    ],
  },
}
```

## 리소스 접근

에이전트가 MCP 리소스 사용:

```
mcp_resource(server: "github", uri: "github://repos/owner/repo")
```

## 도구 사용

에이전트가 MCP 도구 호출:

```
mcp_tool(server: "github", tool: "create_issue", args: {...})
```

## 커스텀 MCP 서버

### Python 서버

```python
from mcp import Server

server = Server("my-server")

@server.tool("hello")
def hello(name: str):
    return f"Hello, {name}!"

server.run()
```

### 설정

```json5
{
  mcp: {
    servers: [
      {
        name: "my-server",
        command: "python",
        args: ["my_mcp_server.py"],
      },
    ],
  },
}
```

## 보안

### 읽기 전용

```json5
{
  mcp: {
    servers: [
      {
        name: "filesystem",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "--read-only",
          "/path",
        ],
      },
    ],
  },
}
```

### 승인 필요

```json5
{
  mcp: {
    requireApproval: true,
  },
}
```

## 문제 해결

### 서버 시작 실패

1. 명령어 경로 확인
2. 환경변수 확인
3. 로그 확인

### 도구 사용 불가

1. 서버 상태 확인
2. 에이전트 MCP 설정 확인
