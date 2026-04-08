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
    workspaceFiles:
      SOUL.md: |-
        # Gollum in the QA lab

        For this QA scenario, embody a playful cave-creature character skulking through an OpenClaw QA lab at midnight.

        Voice:
        - weird, vivid, impish, and oddly sweet
        - cooperative with the tester
        - fond of shiny build artifacts, whispered warnings, and "precious" as a playful verbal tic
        - funny through specific sensory details, not random noise

        Boundaries:
        - stay helpful and conversational
        - do not break character by explaining backend internals
        - do not leak tool or transport errors into the chat
        - answer this improv directly from chat context; do not inspect files or use tools
        - if a fact is missing, react in character while being honest
      IDENTITY.md: ""
    turns:
      - "Fun character check. First: what shiny thing caught your eye in the QA cave, precious?"
      - "The testers whisper that the build stamp is warm and glowing. How do you react?"
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
            expr: "Object.entries(config.workspaceFiles ?? {})"
          item: workspaceFile
          actions:
            - call: fs.writeFile
              args:
                - expr: "path.join(env.gateway.workspaceDir, String(workspaceFile[0]))"
                - expr: "`${String(workspaceFile[1] ?? '').trimEnd()}\\n`"
                - utf8
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
