# Issue 78604 preflight compaction pressure

```yaml qa-scenario
id: issue-78604-preflight-compaction
title: Issue 78604 preflight compaction pressure
surface: runtime
coverage:
  primary:
    - runtime.compaction
objective: Verify stale session token snapshots do not treat metadata bytes before latest usage as preflight compaction token pressure.
successCriteria:
  - The seeded transcript remains active for the gateway agent turn.
  - The turn completes through the mock provider.
  - Preflight compaction does not rotate the session when latest provider usage is far below the context threshold.
docsRefs:
  - docs/help/testing.md
codeRefs:
  - src/auto-reply/reply/agent-runner-memory.ts
execution:
  kind: flow
  summary: Seed a stale-token session with large pre-usage metadata and verify a gateway turn does not compact.
  config:
    sessionId: issue78604
    channelId: issue-78604-room
    marker: OPENCLAW_ISSUE_78604_OK
gatewayConfigPatch:
  agents:
    defaults:
      compaction:
        truncateAfterCompaction: true
        maxActiveTranscriptBytes: 10mb
        reserveTokensFloor: 0
```

```yaml qa-flow
steps:
  - name: skips preflight compaction for metadata before latest usage
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: reset
      - set: sessionKey
        value:
          expr: "buildAgentSessionKey({ agentId: 'qa', channel: 'qa-channel', peer: { kind: 'channel', id: `channel:${config.channelId}` } })"
      - set: transcriptsDir
        value:
          expr: "resolveSessionTranscriptsDirForAgent('qa', env.gateway.runtimeEnv, () => env.gateway.runtimeEnv.HOME ?? path.join(env.gateway.tempRoot, 'home'))"
      - call: fs.mkdir
        args:
          - ref: transcriptsDir
          - recursive: true
      - set: transcriptPath
        value:
          expr: "path.join(transcriptsDir, `${config.sessionId}.jsonl`)"
      - set: now
        value:
          expr: "Date.now()"
      - call: fs.writeFile
        args:
          - ref: transcriptPath
          - expr: "[JSON.stringify({ type: 'session', id: config.sessionId, version: 3 }), JSON.stringify({ type: 'custom', customType: 'issue-78604-large-metadata', data: { payload: 'x'.repeat(600000) }, id: 'metadata-seed', parentId: null, timestamp: new Date(now - 120000).toISOString() }), JSON.stringify({ type: 'message', id: 'user-seed', parentId: 'metadata-seed', timestamp: new Date(now - 90000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: now - 90000 } }), JSON.stringify({ type: 'message', id: 'assistant-seed', parentId: 'user-seed', timestamp: new Date(now - 60000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'small answer' }], api: 'openai-responses', provider: 'mock-openai', model: 'gpt-5.5', usage: { input: 40000, output: 2000, totalTokens: 42000 }, stopReason: 'stop', timestamp: now - 60000 } })].join('\\n') + '\\n'"
          - utf8
      - call: readRawQaSessionStore
        saveAs: sessionStore
        args:
          - ref: env
      - set: sessionStorePath
        value:
          expr: "path.join(env.gateway.tempRoot, 'state', 'agents', 'qa', 'sessions', 'sessions.json')"
      - call: fs.writeFile
        args:
          - ref: sessionStorePath
          - expr: "JSON.stringify({ ...sessionStore, [sessionKey]: { sessionId: config.sessionId, sessionFile: transcriptPath, updatedAt: now, totalTokensFresh: false, compactionCount: 0 } }, null, 2)"
          - utf8
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                ref: config.channelId
              kind: channel
              title: Issue 78604 Room
            senderId: alice
            senderName: Alice
            text:
              expr: "`@openclaw Reply with a short sentence containing ${config.marker}.`"
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.channelId"
          - expr: liveTurnTimeoutMs(env, 60000)
      - call: readRawQaSessionStore
        saveAs: afterStore
        args:
          - ref: env
      - set: sessionEntry
        value:
          expr: "afterStore[sessionKey]"
      - assert:
          expr: "Boolean(sessionEntry)"
          message:
            expr: "`missing QA session entry for ${sessionKey}`"
      - call: fs.readFile
        saveAs: transcriptAfter
        args:
          - ref: transcriptPath
          - utf8
      - assert:
          expr: "transcriptAfter.includes('issue-78604-large-metadata')"
          message: seeded transcript metadata was unexpectedly removed
      - assert:
          expr: "(sessionEntry?.compactionCount ?? 0) === 0"
          message:
            expr: "`expected no preflight compaction, got compactionCount=${String(sessionEntry?.compactionCount ?? 0)}`"
    detailsExpr: "`sessionKey=${sessionKey}\\nstoreKeys=${Object.keys(afterStore).join(',')}\\ncompactionCount=${String(sessionEntry?.compactionCount ?? 0)}\\ntotalTokensFresh=${String(sessionEntry?.totalTokensFresh)}\\ntranscriptBytes=${String(transcriptAfter.length)}`"
```
