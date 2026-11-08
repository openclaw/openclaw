# Signal quoted identity repair

## Source and outcome

Base: `d43ff5a7e42ae141d1ec2eb2ade3216bfb31e916` (public OpenClaw main). The implementation and tests are committed together with this proof on the assigned task branch. Issues: [#195035](https://github.com/openclaw/openclaw/issues/195035) (quoted identity), [#195036](https://github.com/openclaw/openclaw/issues/195036) (UUID author).

Signal now carries the filtered incoming quote ID/body/author in the existing `ReplyChain` contract. Its canonical current `ReplyToId` remains unchanged. The superseded quote-to-scalar supplemental projection is removed. The quote parser classifies legacy UUID authors before number normalization and consumes the modern number/UUID fields, retaining existing alias policy matching.

This follows the existing Nextcloud Talk producer pattern (`extensions/nextcloud-talk/src/inbound.ts`) and shared formatter contract (`src/auto-reply/reply/inbound-meta.ts`); no core, SDK, Signal threading adapter, global identity or reaction behavior changes.

## Reproduction and acceptance

All events and identities are fictional. C=`1700000001001`, Q1=`1700000000007`, Q2=`1700000000008`, edit native target T=`1700000000002`, quoted UUID=`b2345678-90ab-4cde-8f01-23456789abcd`. Ordinary envelope and data-message timestamps match. Paired inputs differ only in Q.

The committed root integration test drives serialized signal-cli notifications through the public Signal monitor, actual SSE receive/parser, real local ingress queue and context builder. It parses the production formatter's actual fenced JSON and requires the original message ID, body, and UUID author together in one quote entry. Native HTTP sends terminate at a single suite-owned loopback recorder. The actual Signal plugin is registered per test for core threading preparation.

| Boundary                 | Required observed contract                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Rendered quote           | Q1/Q2 remain distinguishable, each attached to its own older body and UUID sender                                                         |
| UUID author              | `uuid:b2345678-90ab-4cde-8f01-23456789abcd`; never fabricated `+234567890480123456789`                                                    |
| Message-tool preparation | Actual finalized context → `buildThreadingToolContext` → `resolveAndApplyOutboundReplyToId`; C or T remains target                        |
| CLI preparation          | Actual finalized context + existing run fixture → `buildReplyRouteThreadingToolContext` → `prepareCliReplyPayload`; C or T remains target |
| Native block             | Production native reply planner/sender serializes current author/body and C/T                                                             |
| Native final adapter     | Actual monitor final planner → Signal message adapter → production sender serializes current author/body and C/T                          |
| Edit                     | Event MessageSid=C, current native target=T, older quoted referent=Q; current-body reply-author registration retained                     |
| No quote                 | No fabricated or stale quote body/author                                                                                                  |
| Quote policy             | Same UUID quote allowed/denied/allowlist_quote decisions unchanged; denied quote ID/body/author absent                                    |
| Batching                 | Existing fake-clock handler test preserves combined body, last native target/body, and last entry's quote or its absence                  |
| Author shapes            | Legacy bare UUID and modern phone+UUID alias retain UUID-policy matching and correct displayed primary identity                           |

## Commands and results

Environment: Node 26.13.0, pnpm 12.15.0, own frozen dependencies installed with ignored lifecycle scripts. Source/test execution used bwrap with cleared environment, a fake home, no credentials or external network, and only task-owned source/dependencies mounted writable. Loopback networking exists only inside that network namespace.

Maintained test command:

```sh
node scripts/run-vitest.mjs test/signal-quote-context.integration.test.ts extensions/signal/src/monitor/event-handler.inbound-context.test.ts extensions/signal/src/core.test.ts extensions/signal/src/monitor.tool-result.autostart.test.ts --maxWorkers=1
```

The root integration test is registered in the existing tooling-isolated fork lane because the real ingress queue requires the host-owned shared-state broker. A first threaded run failed at that setup boundary (106.76 seconds); it was not counted as a product regression.

Before production changes, the new rendered-context regressions completed with **3 failed / 1 passed** in 55.96 seconds using the supported fork runtime. The actual formatted payload contained current ID C beside the older body and the fabricated phone label. The no-quote control passed. Red checkpoint test SHA-256: `58c06a21a0dde17924bc3fff4027c8782bdb5d0c17fed616cdbed5274a32beb2`. The final fixture additionally registers the plugin per test and exercises the native final adapter; the discriminating quote assertions are unchanged.

The first candidate run passed the original rendered-ID/UUID assertion and all 33 then-present owner tests. Two later root controls exposed registry fixture lifetime: runtime setup clears the registry per test. Registration was moved from beforeAll to beforeEach; no production routing change was needed.

Final behavioral command: **99 passed across three shards**, 183.11 seconds wrapper wall time. Root integration: 4 passed in 61.64 seconds; native-delivery sibling: 28 passed in 97.03 seconds; inbound owner and core adapter: 67 passed in 20.72 seconds combined. An earlier standalone owner-file run passed all 33 then-present cases in 79.35 seconds; the final owner suite includes the two additional author-shape cases. These are observed local wall times, not a CI runtime prediction.

Lint required fixture-only braces and a caught async HTTP listener; production and assertions stayed unchanged. After that final fixture edit, the affected root-only command passed **4/4** again: 117.71 seconds file duration, 120.21 seconds wrapper wall time, about 1% test-body time. Production and unchanged owner/native/core evidence above were reused. The public monitor/core consumer composition is needed to detect silent tool/CLI retargeting; narrower field-only checks missed both defects. No artificial sleep or polling was added.

Static checks completed on the final content:

- Maintained `run-tsgo` targeted config: passed. The task-local config extends the root compiler options, sets `rootDir` to the repository root and `noEmit`, and includes the five changed production files, both changed TypeScript test files, and normal source/package/UI/test ambient declarations. Its import closure is checked normally; no casts or suppressions weaken the changed contract.
- Maintained `run-oxlint` on all seven source/test/routing files with that config: **0 warnings, 0 errors**, including CI diagnostic parity with the exact pinned official Bun fork. Offline lint's initial staging failure was a setup failure; the clean setup container was qualified with the system CA target and shasum path, and the normal official stager verified artifact checksum, architecture and revision before offline execution.
- Maintained test-line ratchet, staged comparison against the exact base: **6,574,078 <= 6,574,122**, 44 lines slack. The dedicated **+432** allocation equals this repair's exact net test growth; the shared baseline was unchanged.
- Source/test formatting and documentation formatting use the maintained formatter and its pinned-Bun/oxfmt parity check. `git diff --check` is part of commit closeout.
- Fresh independent source review: **clean**, including a root-fixture-only refresh after the lint fix. Final seven-file SHA-256 manifest digest: `253fed0cad13f9f286abbd4b7406c4b6e301b09bba5ae0d0dbc44ebb51b34c72`.

Author simplify pass retained the existing owners and removed the duplicate scalar quote path. The five production files add 51 and remove 31 lines (net +20); no manager, persistent state, SDK export or alternate formatter was added. Net test growth is +432 lines: the actual public monitor/formatter/tool/CLI/native composition plus edits, last-entry debounce, policy and supported author identities. Each protects a distinct observed failure or affected boundary.

## Proof limits and gates

Model dispatch and core session recording are substituted. The test uses a real local ingress SQLite queue, but it does not establish a live provider/model call, durable core transcript or outbox persistence, process-restart recovery, a real Signal account, or phone-visible behavior. The final-adapter send is invoked through the monitor's actual final plan; it is not a claim about a persisted core durable-outbox row. Message-tool and CLI preparation are real; live model-selected tool execution and CLI subprocess execution are outside this proof.

Existing fake-clock batching/policy owner tests and unchanged native/core sibling tests supply their own bounded contracts; they do not become whole-system proof. Native/container serialization baseline evidence was already independently reproduced before this repair; the new committed integration exercises native HTTP. Container/live-device parity remains unclaimed by this new test.

Fresh independent precommit source review and local required checks are complete. Normal exact-head external CI/review and human merge gates remain. This worker does not push, open a PR, deploy or merge. No private account, message history or business integration source is included.
