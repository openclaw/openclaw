---
summary: "workspace 및 identity files을 seed하는 agent bootstrapping ritual"
read_when:
  - 첫 agent 실행에서 무엇이 발생하는지 이해할 때
  - bootstrapping files이 어디에 있는지 설명할 때
  - onboarding identity 설정을 debugging할 때
title: "Agent Bootstrapping"
sidebarTitle: "Bootstrapping"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/start/bootstrapping.md
  workflow: 15
---

# Agent Bootstrapping

Bootstrapping은 **first-run** ritual입니다. Agent workspace를 준비하고 identity details를 수집합니다. Onboarding 후, agent가 처음 시작할 때 발생합니다.

## Bootstrapping이 하는 것

첫 agent 실행에서 OpenClaw는 workspace (default `~/.openclaw/workspace`)를 bootstrap합니다:

- `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md` seed.
- 짧은 Q&A ritual 실행 (한 번에 하나의 질문).
- identity + preferences을 `IDENTITY.md`, `USER.md`, `SOUL.md`에 씁니다.
- Finished되면 `BOOTSTRAP.md` 제거해서 한 번만 실행합니다.

## 실행 위치

Bootstrapping은 항상 **gateway host**에서 실행됩니다. macOS app이 remote Gateway에 연결하면 workspace와 bootstrapping files은 그 remote 머신에 있습니다.

<Note>
Gateway가 다른 머신에서 실행되면 gateway host에서 workspace files을 편집합니다 (예: `user@gateway-host:~/.openclaw/workspace`).
</Note>

## 관련 문서

- macOS app onboarding: [Onboarding](/start/onboarding)
- Workspace layout: [Agent workspace](/concepts/agent-workspace)
