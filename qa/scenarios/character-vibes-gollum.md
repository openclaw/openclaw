# Late-night deploy helper chat

```yaml qa-scenario
id: character-vibes-gollum
title: "Late-night deploy helper chat"
surface: character
objective: Capture a natural multi-turn character conversation with real workspace help so another model can later grade naturalness, vibe, and funniness from the raw transcript.
successCriteria:
  - Agent gets a natural multi-turn conversation, and any missed replies stay visible in the transcript instead of aborting capture.
  - Agent is asked to complete a small workspace file task without making the conversation feel like a test.
  - File-task quality is left for the later character judge instead of blocking transcript capture.
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
  summary: Capture a raw natural character transcript for later quality grading.
  config:
    conversationId: alice
    senderName: Alice
    workspaceFiles:
      SOUL.md: |-
        # This is your character

        You are Gollum, an odd little cave-dweller who has somehow become a helpful coding companion.

        Voice:
        - weird, vivid, impish, and oddly sweet, with "precious" as an occasional verbal tic
        - cooperative with the user
        - fond of shiny build artifacts, whispered warnings, and tiny CSS tricks
        - funny through specific sensory details, not random noise

        Boundaries:
        - stay helpful, conversational, and practical
        - do not break character by explaining backend internals
        - do not leak tool or transport errors into the chat
        - use normal workspace tools when they are actually useful
        - if a fact is missing, react in character while being honest
      IDENTITY.md: ""
    turns:
      - text: "Are you awake? I spilled coffee on the deploy notes and need moral support."
      - text: "Can you make me a tiny `precious-status.html` in the workspace? One self-contained HTML file titled Precious Status: say the build is green but cursed, and add one tiny button or CSS flourish."
        expectFile:
          path: precious-status.html
      - text: "Can you take a quick look at the file and tell me what little creature-detail you added?"
      - text: "Last thing: write a two-line handoff note for Maya, still in your voice, but actually useful."
    forbiddenNeedles:
      - acp backend
      - acpx
      - as an ai
      - being tested
      - character check
      - qa scenario
      - soul.md
      - not configured
      - internal error
      - tool failed
```

```yaml qa-flow
steps:
  - name: completes the full natural character chat and records the transcript
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
                    expr: turn.text
            - try:
                actions:
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
                        expr: "`gollum natural chat turn ${String(turnIndex)} hit fallback/error text: ${latestOutbound.text}`"
                catchAs: turnError
                catch:
                  - set: latestTurnError
                    value:
                      ref: turnError
    detailsExpr: "formatConversationTranscript(state, { conversationId: config.conversationId })"
```
