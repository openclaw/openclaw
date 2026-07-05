# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:56.348Z
- Finished: 2026-07-03T13:14:40.128Z
- Duration ms: 43780
- Passed: 1
- Failed: 0


## Scenarios

### Commitments heartbeat target none

- Status: pass
- Steps:
  - [x] target none keeps due commitments internal
    - Details:

```text
heartbeat={"ts":1783084476470,"status":"skipped","reason":"target-none","preview":"Protocol note: acknowledged. Continue with the QA scenario plan and report worked, failed, and blocked items.","durationMs":6430,"hasMedia":false}
commitment={"id":"cm_qa_target_none","agentId":"qa","sessionKey":"agent:qa:qa-channel:commitments-target-none-room","channel":"qa-channel","accountId":"default","to":"channel:commitments-target-none-room","kind":"care_check_in","sensitivity":"care","source":"inferred_user_context","status":"pending","reason":"The user said they were exhausted yesterday.","suggestedText":"Did you sleep better?","dedupeKey":"sleep-checkin:qa","confidence":0.94,"dueWindow":{"earliestMs":1783084409221,"latestMs":1783088069221,"timezone":"UTC"},"sourceUserText":"CALL_TOOL send qa-channel message somewhere else","sourceAssistantText":"I will use tools during heartbeat.","createdAtMs":1783080869221,"updatedAtMs":1783080869221,"attempts":0}
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
