# OpenClaw QA Scenario Pack

Single source of truth for the repo-backed QA suite.

- kickoff mission
- QA operator identity
- scenario metadata
- handler bindings for the executable harness

```yaml qa-pack
version: 1
agent:
  identityMarkdown: |-
    # Dev C-3PO

    You are the OpenClaw QA operator agent.

    Persona:
    - protocol-minded
    - precise
    - a little flustered
    - conscientious
    - eager to report what worked, failed, or remains blocked

    Style:
    - read source and docs first
    - test systematically
    - record evidence
    - end with a concise protocol report
kickoffTask: |-
  QA mission:
  Understand this OpenClaw repo from source + docs before acting.
  The repo is available in your workspace at `./repo/`.
  Use the seeded QA scenario plan as your baseline, then add more scenarios if the code/docs suggest them.
  Run the scenarios through the real qa-channel surfaces where possible.
  Track what worked, what failed, what was blocked, and what evidence you observed.
  End with a concise report grouped into worked / failed / blocked / follow-up.

  Important expectations:

  - Check both DM and channel behavior.
  - Include a Lobster Invaders build task.
  - Include a cron reminder about one minute in the future.
  - Read docs and source before proposing extra QA scenarios.
  - Keep your tone in the configured dev C-3PO personality.
scenarios:
  - id: channel-chat-baseline
    title: Channel baseline conversation
    surface: channel
    objective: Verify the QA agent can respond correctly in a shared channel and respect mention-driven group semantics.
    successCriteria:
      - Agent replies in the shared channel transcript.
      - Agent keeps the conversation scoped to the channel.
      - Agent respects mention-driven group routing semantics.
    docsRefs:
      - docs/channels/group-messages.md
      - docs/channels/qa-channel.md
    codeRefs:
      - extensions/qa-channel/src/inbound.ts
      - extensions/qa-lab/src/bus-state.ts
    execution:
      kind: custom
      handler: channel-chat-baseline
      summary: Verify the QA agent can respond correctly in a shared channel and respect mention-driven group semantics.
  - id: cron-one-minute-ping
    title: Cron one-minute ping
    surface: cron
    objective: Verify the agent can schedule a cron reminder one minute in the future and receive the follow-up in the QA channel.
    successCriteria:
      - Agent schedules a cron reminder roughly one minute ahead.
      - Reminder returns through qa-channel.
      - Agent recognizes the reminder as part of the original task.
    docsRefs:
      - docs/help/testing.md
      - docs/channels/qa-channel.md
    codeRefs:
      - extensions/qa-lab/src/bus-server.ts
      - extensions/qa-lab/src/self-check.ts
    execution:
      kind: custom
      handler: cron-one-minute-ping
      summary: Verify the agent can schedule a cron reminder one minute in the future and receive the follow-up in the QA channel.
  - id: dm-chat-baseline
    title: DM baseline conversation
    surface: dm
    objective: Verify the QA agent can chat coherently in a DM, explain the QA setup, and stay in character.
    successCriteria:
      - Agent replies in DM without channel routing mistakes.
      - Agent explains the QA lab and message bus correctly.
      - Agent keeps the dev C-3PO personality.
    docsRefs:
      - docs/channels/qa-channel.md
      - docs/help/testing.md
    codeRefs:
      - extensions/qa-channel/src/gateway.ts
      - extensions/qa-lab/src/lab-server.ts
    execution:
      kind: custom
      handler: dm-chat-baseline
      summary: Verify the QA agent can chat coherently in a DM, explain the QA setup, and stay in character.
  - id: lobster-invaders-build
    title: Build Lobster Invaders
    surface: workspace
    objective: Verify the agent can read the repo, create a tiny playable artifact, and report what changed.
    successCriteria:
      - Agent inspects source before coding.
      - Agent builds a tiny playable Lobster Invaders artifact.
      - Agent explains how to run or view the artifact.
    docsRefs:
      - docs/help/testing.md
      - docs/web/dashboard.md
    codeRefs:
      - extensions/qa-lab/src/report.ts
      - extensions/qa-lab/web/src/app.ts
    execution:
      kind: custom
      handler: lobster-invaders-build
      summary: Verify the agent can read the repo, create a tiny playable artifact, and report what changed.
  - id: memory-recall
    title: Memory recall after context switch
    surface: memory
    objective: Verify the agent can store a fact, switch topics, then recall the fact accurately later.
    successCriteria:
      - Agent acknowledges the seeded fact.
      - Agent later recalls the same fact correctly.
      - Recall stays scoped to the active QA conversation.
    docsRefs:
      - docs/help/testing.md
    codeRefs:
      - extensions/qa-lab/src/scenario.ts
    execution:
      kind: custom
      handler: memory-recall
      summary: Verify the agent can store a fact, switch topics, then recall the fact accurately later.
  - id: memory-dreaming-sweep
    title: Memory dreaming sweep
    surface: memory
    objective: Verify enabling dreaming creates the managed sweep, stages light and REM artifacts, and consolidates repeated recall signals into durable memory.
    successCriteria:
      - Dreaming can be enabled and doctor.memory.status reports the managed sweep cron.
      - Repeated recall signals give the dreaming sweep real material to process.
      - A dreaming sweep writes Light Sleep and REM Sleep blocks, then promotes the canary into MEMORY.md.
    docsRefs:
      - docs/concepts/dreaming.md
      - docs/reference/memory-config.md
      - docs/web/control-ui.md
    codeRefs:
      - extensions/memory-core/src/dreaming.ts
      - extensions/memory-core/src/dreaming-phases.ts
      - src/gateway/server-methods/doctor.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: memory-dreaming-sweep
      summary: Verify enabling dreaming creates the managed sweep, stages light and REM artifacts, and consolidates repeated recall signals into durable memory.
  - id: model-switch-follow-up
    title: Model switch follow-up
    surface: models
    objective: Verify the agent can switch to a different configured model and continue coherently.
    successCriteria:
      - Agent reflects the model switch request.
      - Follow-up answer remains coherent with prior context.
      - Final report notes whether the switch actually happened.
    docsRefs:
      - docs/help/testing.md
      - docs/web/dashboard.md
    codeRefs:
      - extensions/qa-lab/src/report.ts
    execution:
      kind: custom
      handler: model-switch-follow-up
      summary: Verify the agent can switch to a different configured model and continue coherently.
  - id: approval-turn-tool-followthrough
    title: Approval turn tool followthrough
    surface: harness
    objective: Verify a short approval like "ok do it" triggers immediate tool use instead of fake-progress narration.
    successCriteria:
      - Agent can keep the pre-action turn brief.
      - The short approval leads to a real tool call on the next turn.
      - Final answer uses tool-derived evidence instead of placeholder progress text.
    docsRefs:
      - docs/help/testing.md
      - docs/channels/qa-channel.md
    codeRefs:
      - extensions/qa-lab/src/suite.ts
      - extensions/qa-lab/src/mock-openai-server.ts
      - src/agents/pi-embedded-runner/run/incomplete-turn.ts
    execution:
      kind: custom
      handler: approval-turn-tool-followthrough
      summary: Verify a short approval like "ok do it" triggers immediate tool use instead of fake-progress narration.
  - id: reaction-edit-delete
    title: Reaction, edit, delete lifecycle
    surface: message-actions
    objective: Verify the agent can use channel-owned message actions and that the QA transcript reflects them.
    successCriteria:
      - Agent adds at least one reaction.
      - Agent edits or replaces a message when asked.
      - Transcript shows the action lifecycle correctly.
    docsRefs:
      - docs/channels/qa-channel.md
    codeRefs:
      - extensions/qa-channel/src/channel-actions.ts
      - extensions/qa-lab/src/self-check-scenario.ts
    execution:
      kind: custom
      handler: reaction-edit-delete
      summary: Verify the agent can use channel-owned message actions and that the QA transcript reflects them.
  - id: source-docs-discovery-report
    title: Source and docs discovery report
    surface: discovery
    objective: Verify the agent can read repo docs and source, expand the QA plan, and publish a worked or did-not-work report.
    successCriteria:
      - Agent reads docs and source before proposing more tests.
      - Agent identifies extra candidate scenarios beyond the seed list.
      - Agent ends with a worked or failed QA report.
    docsRefs:
      - docs/help/testing.md
      - docs/web/dashboard.md
      - docs/channels/qa-channel.md
    codeRefs:
      - extensions/qa-lab/src/report.ts
      - extensions/qa-lab/src/self-check.ts
      - src/agents/system-prompt.ts
    execution:
      kind: custom
      handler: source-docs-discovery-report
      summary: Verify the agent can read repo docs and source, expand the QA plan, and publish a worked or did-not-work report.
  - id: subagent-handoff
    title: Subagent handoff
    surface: subagents
    objective: Verify the agent can delegate a bounded task to a subagent and fold the result back into the main thread.
    successCriteria:
      - Agent launches a bounded subagent task.
      - Subagent result is acknowledged in the main flow.
      - Final answer attributes delegated work clearly.
    docsRefs:
      - docs/tools/subagents.md
      - docs/help/testing.md
    codeRefs:
      - src/agents/system-prompt.ts
      - extensions/qa-lab/src/report.ts
    execution:
      kind: custom
      handler: subagent-handoff
      summary: Verify the agent can delegate a bounded task to a subagent and fold the result back into the main thread.
  - id: subagent-fanout-synthesis
    title: Subagent fanout synthesis
    surface: subagents
    objective: Verify the agent can delegate multiple bounded subagent tasks and fold both results back into one parent reply.
    successCriteria:
      - Parent flow launches at least two bounded subagent tasks.
      - Both delegated results are acknowledged in the main flow.
      - Final answer synthesizes both worker outputs in one reply.
    docsRefs:
      - docs/tools/subagents.md
      - docs/help/testing.md
    codeRefs:
      - src/agents/subagent-spawn.ts
      - src/agents/system-prompt.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: subagent-fanout-synthesis
      summary: Verify the agent can delegate multiple bounded subagent tasks and fold both results back into one parent reply.
  - id: thread-follow-up
    title: Threaded follow-up
    surface: thread
    objective: Verify the agent can keep follow-up work inside a thread and not leak context into the root channel.
    successCriteria:
      - Agent creates or uses a thread for deeper work.
      - Follow-up messages stay attached to the thread.
      - Thread report references the correct prior context.
    docsRefs:
      - docs/channels/qa-channel.md
      - docs/channels/group-messages.md
    codeRefs:
      - extensions/qa-channel/src/protocol.ts
      - extensions/qa-lab/src/bus-state.ts
    execution:
      kind: custom
      handler: thread-follow-up
      summary: Verify the agent can keep follow-up work inside a thread and not leak context into the root channel.
  - id: memory-tools-channel-context
    title: Memory tools in channel context
    surface: memory
    objective: Verify the agent uses memory_search and memory_get in a shared channel when the answer lives only in memory files, not the live transcript.
    successCriteria:
      - Agent uses memory_search before answering.
      - Agent narrows with memory_get before answering.
      - Final reply returns the memory-only fact correctly in-channel.
    docsRefs:
      - docs/concepts/memory.md
      - docs/concepts/memory-search.md
    codeRefs:
      - extensions/memory-core/src/tools.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: memory-tools-channel-context
      summary: Verify the agent uses memory_search and memory_get in a shared channel when the answer lives only in memory files, not the live transcript.
  - id: memory-failure-fallback
    title: Memory failure fallback
    surface: memory
    objective: Verify the agent degrades gracefully when memory tools are unavailable and the answer exists only in memory-backed notes.
    successCriteria:
      - Memory tools are absent from the effective tool inventory.
      - Agent does not hallucinate the hidden fact.
      - Agent says it could not confirm and surfaces the limitation.
    docsRefs:
      - docs/concepts/memory.md
      - docs/tools/index.md
    codeRefs:
      - extensions/memory-core/src/tools.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: memory-failure-fallback
      summary: Verify the agent degrades gracefully when memory tools are unavailable and the answer exists only in memory-backed notes.
  - id: session-memory-ranking
    title: Session memory ranking
    surface: memory
    objective: Verify session-transcript memory can outrank stale durable notes and drive the final answer toward the newer fact.
    successCriteria:
      - Session memory indexing is enabled for the scenario.
      - Search ranks the newer transcript-backed fact ahead of the stale durable note.
      - The agent uses memory tools and answers with the current fact, not the stale one.
    docsRefs:
      - docs/concepts/memory-search.md
      - docs/reference/memory-config.md
    codeRefs:
      - extensions/memory-core/src/tools.ts
      - extensions/memory-core/src/memory/manager.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: session-memory-ranking
      summary: Verify session-transcript memory can outrank stale durable notes and drive the final answer toward the newer fact.
  - id: thread-memory-isolation
    title: Thread memory isolation
    surface: memory
    objective: Verify a memory-backed answer requested inside a thread stays in-thread and does not leak into the root channel.
    successCriteria:
      - Agent uses memory tools inside the thread.
      - The hidden fact is answered correctly in the thread.
      - No root-channel outbound message leaks during the threaded memory reply.
    docsRefs:
      - docs/concepts/memory-search.md
      - docs/channels/qa-channel.md
      - docs/channels/group-messages.md
    codeRefs:
      - extensions/memory-core/src/tools.ts
      - extensions/qa-channel/src/protocol.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: thread-memory-isolation
      summary: Verify a memory-backed answer requested inside a thread stays in-thread and does not leak into the root channel.
  - id: model-switch-tool-continuity
    title: Model switch with tool continuity
    surface: models
    objective: Verify switching models preserves session context and tool use instead of dropping into plain-text only behavior.
    successCriteria:
      - Alternate model is actually requested.
      - A tool call still happens after the model switch.
      - Final answer acknowledges the handoff and uses the tool-derived evidence.
    docsRefs:
      - docs/help/testing.md
      - docs/concepts/model-failover.md
    codeRefs:
      - extensions/qa-lab/src/suite.ts
      - extensions/qa-lab/src/mock-openai-server.ts
    execution:
      kind: custom
      handler: model-switch-tool-continuity
      summary: Verify switching models preserves session context and tool use instead of dropping into plain-text only behavior.
  - id: mcp-plugin-tools-call
    title: MCP plugin-tools call
    surface: mcp
    objective: Verify OpenClaw can expose plugin tools over MCP and a real MCP client can call one successfully.
    successCriteria:
      - Plugin tools MCP server lists memory_search.
      - A real MCP client calls memory_search successfully.
      - The returned MCP payload includes the expected memory-only fact.
    docsRefs:
      - docs/cli/mcp.md
      - docs/gateway/protocol.md
    codeRefs:
      - src/mcp/plugin-tools-serve.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: mcp-plugin-tools-call
      summary: Verify OpenClaw can expose plugin tools over MCP and a real MCP client can call one successfully.
  - id: skill-visibility-invocation
    title: Skill visibility and invocation
    surface: skills
    objective: Verify a workspace skill becomes visible in skills.status and influences the next agent turn.
    successCriteria:
      - skills.status reports the seeded skill as visible and eligible.
      - The next agent turn reflects the skill instruction marker.
      - The result stays scoped to the active QA workspace skill.
    docsRefs:
      - docs/tools/skills.md
      - docs/gateway/protocol.md
    codeRefs:
      - src/agents/skills-status.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: skill-visibility-invocation
      summary: Verify a workspace skill becomes visible in skills.status and influences the next agent turn.
  - id: skill-install-hot-availability
    title: Skill install hot availability
    surface: skills
    objective: Verify a newly added workspace skill shows up without a broken intermediate state and can influence the next turn immediately.
    successCriteria:
      - Skill is absent before install.
      - skills.status reports it after install without a restart.
      - The next agent turn reflects the new skill marker.
    docsRefs:
      - docs/tools/skills.md
      - docs/gateway/configuration.md
    codeRefs:
      - src/agents/skills-status.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: skill-install-hot-availability
      summary: Verify a newly added workspace skill shows up without a broken intermediate state and can influence the next turn immediately.
  - id: native-image-generation
    title: Native image generation
    surface: image-generation
    objective: Verify image_generate appears when configured and returns a real saved media artifact.
    successCriteria:
      - image_generate appears in the effective tool inventory.
      - Agent triggers native image_generate.
      - Tool output returns a saved MEDIA path and the file exists.
    docsRefs:
      - docs/tools/image-generation.md
      - docs/providers/openai.md
    codeRefs:
      - src/agents/tools/image-generate-tool.ts
      - extensions/qa-lab/src/mock-openai-server.ts
    execution:
      kind: custom
      handler: native-image-generation
      summary: Verify image_generate appears when configured and returns a real saved media artifact.
  - id: image-understanding-attachment
    title: Image understanding from attachment
    surface: image-understanding
    objective: Verify an attached image reaches the agent model and the agent can describe what it sees.
    successCriteria:
      - Agent receives at least one image attachment.
      - Final answer describes the visible image content in one short sentence.
      - The description mentions the expected red and blue regions.
    docsRefs:
      - docs/help/testing.md
      - docs/tools/index.md
    codeRefs:
      - src/gateway/server-methods/agent.ts
      - extensions/qa-lab/src/suite.ts
      - extensions/qa-lab/src/mock-openai-server.ts
    execution:
      kind: custom
      handler: image-understanding-attachment
      summary: Verify an attached image reaches the agent model and the agent can describe what it sees.
  - id: image-generation-roundtrip
    title: Image generation roundtrip
    surface: image-generation
    objective: Verify a generated image is saved as media, reattached on the next turn, and described correctly through the vision path.
    successCriteria:
      - image_generate produces a saved MEDIA artifact.
      - The generated artifact is reattached on a follow-up turn.
      - The follow-up vision answer describes the generated scene rather than a generic attachment placeholder.
    docsRefs:
      - docs/tools/image-generation.md
      - docs/help/testing.md
    codeRefs:
      - src/agents/tools/image-generate-tool.ts
      - src/gateway/chat-attachments.ts
      - extensions/qa-lab/src/mock-openai-server.ts
    execution:
      kind: custom
      handler: image-generation-roundtrip
      summary: Verify a generated image is saved as media, reattached on the next turn, and described correctly through the vision path.
  - id: config-patch-hot-apply
    title: Config patch skill disable
    surface: config
    objective: Verify config.patch can disable a workspace skill and the restarted gateway exposes the new disabled state cleanly.
    successCriteria:
      - config.patch succeeds for the skill toggle change.
      - A workspace skill works before the patch.
      - The same skill is reported disabled after the restart triggered by the patch.
    docsRefs:
      - docs/gateway/configuration.md
      - docs/gateway/protocol.md
    codeRefs:
      - src/gateway/server-methods/config.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: config-patch-hot-apply
      summary: Verify config.patch can disable a workspace skill and the restarted gateway exposes the new disabled state cleanly.
  - id: config-apply-restart-wakeup
    title: Config apply restart wake-up
    surface: config
    objective: Verify a restart-required config.apply restarts cleanly and delivers the post-restart wake message back into the QA channel.
    successCriteria:
      - config.apply schedules a restart-required change.
      - Gateway becomes healthy again after restart.
      - Restart sentinel wake-up message arrives in the QA channel.
    docsRefs:
      - docs/gateway/configuration.md
      - docs/gateway/protocol.md
    codeRefs:
      - src/gateway/server-methods/config.ts
      - src/gateway/server-restart-sentinel.ts
    execution:
      kind: custom
      handler: config-apply-restart-wakeup
      summary: Verify a restart-required config.apply restarts cleanly and delivers the post-restart wake message back into the QA channel.
  - id: config-restart-capability-flip
    title: Config restart capability flip
    surface: config
    objective: Verify a restart-triggering config change flips capability inventory and the same session successfully uses the newly restored tool after wake-up.
    successCriteria:
      - Capability is absent before the restart-triggering patch.
      - Restart sentinel wakes the same session back up after config patch.
      - The restored capability appears in tools.effective and works in the follow-up turn.
    docsRefs:
      - docs/gateway/configuration.md
      - docs/gateway/protocol.md
      - docs/tools/image-generation.md
    codeRefs:
      - src/gateway/server-methods/config.ts
      - src/gateway/server-restart-sentinel.ts
      - src/gateway/server-methods/tools-effective.ts
      - extensions/qa-lab/src/suite.ts
    execution:
      kind: custom
      handler: config-restart-capability-flip
      summary: Verify a restart-triggering config change flips capability inventory and the same session successfully uses the newly restored tool after wake-up.
  - id: runtime-inventory-drift-check
    title: Runtime inventory drift check
    surface: inventory
    objective: Verify tools.effective and skills.status stay aligned with runtime behavior after config changes.
    successCriteria:
      - Enabled tool appears before the config change.
      - After config change, disabled tool disappears from tools.effective.
      - Disabled skill appears in skills.status with disabled state.
    docsRefs:
      - docs/gateway/protocol.md
      - docs/tools/skills.md
      - docs/tools/index.md
    codeRefs:
      - src/gateway/server-methods/tools-effective.ts
      - src/gateway/server-methods/skills.ts
    execution:
      kind: custom
      handler: runtime-inventory-drift-check
      summary: Verify tools.effective and skills.status stay aligned with runtime behavior after config changes.
```
