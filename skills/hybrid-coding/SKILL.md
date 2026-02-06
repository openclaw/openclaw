---
name: hybrid-coding
description: Set up the hybrid coding pattern (MAIBOT orchestrator + Claude Code CLI developer) on a project. Creates CLAUDE.md, sub-agents, and MCP config. Use when initializing a new project for hybrid coding or updating an existing project's Claude Code setup.
---

# Hybrid Coding Setup

MAIBOT(오케스트레이터) + Claude Code CLI(개발자) 하이브리드 코딩 방식을 프로젝트에 적용한다.

## 작업 플로우

```
지니님 지시 → MAIBOT 분석 → Claude Code CLI 실행
                              ├── 필요시 서브에이전트 지정 (--agent)
                              ├── MCP 서버 자동 활용
                              └── CLAUDE.md 자동 참조
```

## 프로젝트에 필요한 파일 3종

### 1. CLAUDE.md (프로젝트 루트)

Claude Code가 자동 참조하는 프로젝트 가이드. 반드시 포함할 내용:
- 하이브리드 코딩 방식 설명 + 플로우 다이어그램
- 서브에이전트 팀 구성 목록
- MCP 서버 목록
- 프로젝트 개요, 기술 스택, 핵심 규칙

### 2. .claude/agents/*.md (서브에이전트)

프로젝트 역할에 맞는 전문 에이전트 3~6종. 각 에이전트에 포함:
- `# 에이전트명` + 한줄 설명
- `## 역할` — 담당 영역
- `## 워크스페이스` — 주요 파일/폴더
- `## 핵심 역량` — 할 수 있는 것
- `## 기술 스택`
- `## 규칙` — 지켜야 할 것

에이전트는 **프로젝트 특화**로 설계:
- 웹 프로젝트: frontend-dev, backend-dev, devops, test-engineer
- AI/ML 프로젝트: data-engineer, model-trainer, evaluator
- 인프라 프로젝트: gateway-dev, channel-dev, platform-dev

### 3. .mcp.json (MCP 서버)

공통 MCP 서버 (거의 모든 프로젝트에 유용):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "@playwright/mcp"],
      "description": "브라우저 자동화, E2E 테스트"
    },
    "fetcher": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "fetcher-mcp"],
      "description": "웹 콘텐츠 추출"
    },
    "context7": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "@upstash/context7-mcp"],
      "description": "최신 라이브러리 문서"
    },
    "magic": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "@magicuidesign/mcp@latest"],
      "description": "UI 컴포넌트 생성"
    }
  }
}
```

프로젝트별 추가 MCP:
- n8n 프로젝트: `n8n-mcp` (워크플로우 관리)
- DB 프로젝트: `sqlite-mcp` 또는 `postgres-mcp`

## Claude Code 실행 옵션

```bash
# 기본 실행
claude 'task description'

# 서브에이전트 지정
claude --agent test-engineer 'run all tests and fix failures'

# 모델 선택
claude --model opus 'complex refactoring task'

# 세션 이어하기
claude --continue
claude --resume

# 자동 승인 모드
claude --permission-mode bypassPermissions 'task'
```

## 체크리스트

새 프로젝트에 적용할 때:
1. [ ] `CLAUDE.md` 생성 (프로젝트 가이드 + 하이브리드 패턴)
2. [ ] `.claude/agents/` 서브에이전트 3~6종 생성
3. [ ] `.mcp.json` MCP 서버 설정
4. [ ] TOOLS.md에 프로젝트 개발 환경 기록
5. [ ] MEMORY.md에 프로젝트 등록

## 기존 프로젝트 현황

| 프로젝트 | 에이전트 | MCP | CLAUDE.md |
|----------|:--------:|:---:|:---------:|
| MAIBEAUTY | 6종 | 5개 | ✅ |
| MAIOSS | 6종 | 4개 | ✅ |
| MAIBOT | 6종 | 4개 | ✅ |
