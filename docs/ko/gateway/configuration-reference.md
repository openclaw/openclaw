---
title: "구성 참조"
summary: "게이트웨이 구성 참조"
---

# 구성 참조

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

매 대화 턴마다 시스템 프롬프트에 추가되는 텍스트입니다. 대화 기록이 아닌 구성에서 주입되기 때문에 **압축 후에도 유지됩니다** — 긴 세션 동안 절대 손실되어서는 안 되는 영구적인 동작 규칙, 제약 조건 또는 정체성에 이상적입니다.

접미사는 기존 `extraSystemPrompt`(예: 채널 구성 또는 서브에이전트 컨텍스트) _이후에_ 추가되므로 다른 시스템 프롬프트 소스를 대체하지 않습니다.

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "항상 한국어로 응답하세요. 명시적 승인 없이 공개 저장소에 커밋하지 마세요.",
    },
  },
}
```
