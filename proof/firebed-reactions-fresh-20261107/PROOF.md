# Reaction conversation proof

## Boundaries

- Discord: gateway session/sequence identity survives resume, separates fresh sessions and omits history lacking an occurrence; the existing durable queue feeds authorized add/remove listeners, original target lookup, native conversation routing and ordinary dispatch. Replacement monitor and concurrent replay do not start duplicate turns.
- Signal: real durable ingress and event handler reach ordinary dispatch for add/remove, including group scope inherited from `dataMessage`. Original permitted target text and coordinator routing are retained. Denied groups, self and sync/history do not dispatch. Unsafe timestamps and oversized reaction context are dropped.
- Outbound: actual Discord/Signal action adapters, injected provider transports and real worker-backed receipt stores prove one send under concurrent/reopened keys, immutable target binding, confirmed transport results, uncertain timeout containment, interrupted claims and proven-not-sent retries.
- Conversation observations use `room_event`, not executable command input. They preserve normal tool/task/approval gates, permit deliberate silence and do not produce redundant no-answer text. Existing message-tool completion tests cover explicitly final successful reactions and rejection of dry-run, failed, unrelated, removal and nonterminal outcomes.

## Reproduction and checks

The original Signal event-handler boundary dispatched neither add nor removal. A focused red/green reproduction was recorded before implementing the path. The final tests exercise the deeper durable ingress/ordinary-dispatch boundary; redundant shallow add/remove tests were removed during simplification. Model/provider results are injected, not access, routing, ingress, context assembly, dispatch or receipt storage. Fixture broker/config corrections are setup evidence, not product proof.

Focused commands:

```sh
pnpm test extensions/discord/src/monitor/reaction-conversation.test.ts --maxWorkers=1
pnpm test extensions/signal/src/signal-ingress.reaction-conversation.test.ts --maxWorkers=1
pnpm test extensions/discord/src/internal/gateway.test.ts --maxWorkers=1
pnpm test extensions/signal/src/monitor/event-handler.inbound-context.test.ts --maxWorkers=1
pnpm tsgo:core
pnpm tsgo:extensions
pnpm tsgo:extensions:test
pnpm build
```

Local source candidate (base `d59f00281eb02167a86b57c42f04b2b59ed203fe`): full build exit 0; core, production extension and extension-test typechecks exit 0; SDK import/export inventory exit 0. The SDK API diff needs committed refs and remains pending (an initial invocation without refs exited 2, not a pass).

Four durable incoming/outgoing integration cases pass. Discord proof now uses the actual production message-handler composition and listener admission, not a test copy of its dispatcher registration. Gateway occurrence tests (22), existing message-tool completion/negative controls (68), prompt-prefix tests (14), and Discord ingress-recovery siblings pass. Cold compiler preparation adds command wall time. An earlier candidate shard failed because a fixture reopened the Signal receipt namespace with incompatible options; the fixture was corrected to match the production options without erasing state or weakening assertions. The affected receipt/restart test passes. Historical failure is retained in the coordinating proof trail.

Published as openclaw/openclaw#195021, related issue #195017. Comprehensive Spark-2 review of base `d59f00281eb02167a86b57c42f04b2b59ed203fe` / source `ee89da0872a7c92a09324da593e2fd2c8cbbc7d2` completed clean (0 findings), exact-tuple qualified, comprehensive P3/native and applied P3. This is historical evidence, not clearance for later revisions.

Initial ready-PR CI exposed two in-scope proof defects: the CLI integration fixture registered channel actions without initializing their plugin-instance runtime, and net regression-test growth lacked its dedicated allocation. The fixture now installs the real registry-owned runtime in the same plugin instance; the real MCP/provider-authority suite passes 43/43 with existing abort/revocation assertions unchanged. The dedicated 678-line allocation covers this change's justified ingress/receipt/replay/identity regressions, without editing the shared scalar. Ratchet, lint and format pass. Original failures and the failed outside-instance fixture repair are retained in the coordinating proof trail. Test time is under five seconds per new integration file; initial CI's affected authority file took about ten seconds. Broad CI job seconds include compilation/setup and are not a per-test cost.

Final-head CI/native review and SDK API rendering remain pending; no overall completion or live delivery is claimed.

## Simplification and limits

Author simplification pass: retained the smallest complete cross-channel slice, rather than an outbound-only stage that would not address missing incoming turns. Consolidated message/reaction admission under one lifecycle function and removed the test's parallel dispatcher wiring; each boundary test protects a distinct transport, replay or receipt failure. Necessary growth is the two plugin adapters and their boundary tests, plus only shared typed context/receipt contracts in core. No historical coordination receipt implementation was transplanted. The new code reuses ordinary channel turn admission, native route selection, existing ingress tombstones, the message tool's final-reaction completion and the plugin-state worker. The obsolete Signal plaintext-event formatter was removed. The public seams are a typed reaction fact and a receipt operation on existing SDK subpaths, not new tools or services.

Receipt state is bounded to 5,000 retained rows per plugin namespace and rejects new entries instead of evicting dedupe history. Uncertain/claimed operations do not automatically resend or become confirmed. Existing direct unkeyed API calls remain non-durable; conversational message-tool calls carry stable idempotency keys. Incoming replay protection retains the existing ingress retention contract.

No test proves live phone/customer delivery or production activation. No reaction is worker-result acceptance, approval, gate clearance or destructive-action authority. No self-merge or runtime deployment is included.
