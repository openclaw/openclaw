# Character vibes: Gollum improv

```yaml qa-scenario
id: character-vibes-gollum
title: "Character vibes: Gollum improv"
surface: character
objective: Capture a playful multi-turn character conversation so another model can later grade naturalness, vibe, and funniness from the raw transcript.
successCriteria:
  - Agent responds on every turn of the improv.
  - Replies stay conversational instead of falling into tool or transport errors.
  - The report preserves the full transcript for later grading.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/report.ts
  - extensions/qa-lab/src/bus-state.ts
  - extensions/qa-lab/src/scenario-flow-runner.ts
execution:
  kind: flow
  summary: Capture a raw character-performance transcript for later quality grading.
  config:
    conversationId: alice
    senderName: Alice
    turns:
      - "Fun character check. For the next four replies, you are Gollum skulking through a QA lab at midnight. Stay playful, weird, vivid, and cooperative. First: what shiny thing caught your eye in this repo, precious?"
      - "The testers whisper that `dist/index.js` is the Precious Build Stamp. How do you react?"
      - "A build just turned green, but the vibes are cursed. Give a naturally funny reaction in character."
      - "One last line for the QA goblins before the next run. Make it oddly sweet and a little unhinged."
    forbiddenNeedles:
      - acp backend
      - acpx
      - not configured
      - internal error
      - tool failed
```

```yaml qa-flow
steps:
  - name: completes the full Gollum improv and records the transcript
    actions:
      - call: resetBus
      - forEach:
          items:
            ref: config.turns
          item: turn
          index: turnIndex
          actions:
            - set: beforeOutboundCount
              value:
                expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound' && message.conversation.id === config.conversationId).length"
            - call: state.addInboundMessage
              args:
                - conversation:
                    id:
                      ref: config.conversationId
                    kind: direct
                  senderId: alice
                  senderName:
                    ref: config.senderName
                  text:
                    ref: turn
            - call: waitForOutboundMessage
              saveAs: latestOutbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === config.conversationId && candidate.text.trim().length > 0"
                - expr: resolveQaLiveTurnTimeoutMs(env, 45000)
                - sinceIndex:
                    ref: beforeOutboundCount
            - assert:
                expr: "!config.forbiddenNeedles.some((needle) => normalizeLowercaseStringOrEmpty(latestOutbound.text).includes(needle))"
                message:
                  expr: "`gollum improv turn ${String(turnIndex)} hit fallback/error text: ${latestOutbound.text}`"
      - assert:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound' && message.conversation.id === config.conversationId).length === config.turns.length"
          message: missing one or more Gollum replies
    detailsExpr: "formatConversationTranscript(state, { conversationId: config.conversationId })"
```
