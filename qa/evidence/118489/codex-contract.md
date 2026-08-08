# Codex item-id / event-order contract excerpts

Direct excerpts from the sibling `openai/codex` checkout at commit
`8e3b5d3e875fd52f1edff75e2f055e4990e866c0` (2026-08-04), cited by the PR.
These are the exact protocol lines the stale-lifecycle premise depends on.

## Dynamic tool items are keyed by call id

`codex-rs/app-server-protocol/src/protocol/event_mapping.rs:38-70`

```rust
EventMsg::DynamicToolCallResponse(response) => {
    let status = if response.success {
        DynamicToolCallStatus::Completed
    } else {
        DynamicToolCallStatus::Failed
    };
    let duration_ms = i64::try_from(response.duration.as_millis()).ok();
    let item = ThreadItem::DynamicToolCall {
        id: response.call_id,
        namespace: response.namespace,
        tool: response.tool,
        arguments: response.arguments,
        status,
        content_items: Some(...),
        success: Some(response.success),
        duration_ms,
    };
    ServerNotification::ItemCompleted(ItemCompletedNotification { ... })
}
```

The `item/completed` notification item id **is** the dynamic tool call id, so
`item/started` / `item/completed` ids and the call ids OpenClaw records in
`recordDynamicToolCall` / `recordDynamicToolResult` share one namespace.

## Item-completed is the only completion delivery

`codex-rs/app-server/src/bespoke_event_handling.rs:1015-1028` forwards
`EventMsg::ItemCompleted` as the `item/completed` notification; there is no
earlier result-only event for dynamic tools.

## OpenClaw side

- `extensions/codex/src/app-server/event-projector.ts` - `recordDynamicToolResult`
  writes the exact toolResult into the transcript projection when the bridge
  returns, before any `item/completed` can arrive; `handleItemCompleted` is the
  only path that removes an id from `activeItemIds`. A bridge failure between
  the two leaves the exact result persisted with `activeCount` stale - the
  #118489 reproduction-B shape, asserted by
  `event-projector.118489-residual.test.ts` (`activeItemIds: ["call-fail"]`).
- `src/agents/embedded-agent-runner/run/incomplete-turn.ts` - the finalizer
  only overrides a nonzero active count when every recorded active item belongs
  to a requested terminal call with an exact persisted result (`tool:` /
  `command:` / `patch:` id forms), keeping unrelated active work fail-closed.
