# Discord runtime and recovery

## Config and Gateway control

The shared suite is the only Gateway/process and lease owner. A custom flow uses
`env.gateway.call(method, params)` for RPC and existing `readConfigSnapshot`,
`patchConfig`, `applyConfig`, `waitForConfigRestartSettle`, and
`waitForTransportReady` helpers. Do not launch a second Gateway or use a personal
Discord runner. The suite allocates and stops its own processes; it never needs
to kill a port holder.

For startup-only configuration, use the scenario's existing `gatewayConfigPatch`.
For a live change, mutate the temporary Gateway through the flow helper:

```yaml
- call: channelE2e.assertActive
- call: patchConfig
  args:
    - env: { ref: env }
      patch:
        messages:
          statusReactions:
            enabled: true
- call: waitForTransportReady
  args: [{ ref: env }, 60000]
- call: channelE2e.assertActive
- call: env.gateway.call
  args: [channels.status, { probe: true }]
  saveAs: channelStatus
```

`patchConfig` owns hashes, restart settling, and live transport readiness. Use a
`try/finally` with a saved `readConfigSnapshot` and `applyConfig` to restore
runtime changes within a multi-step scenario. Keep complete config snapshots in
memory: they can contain leased credentials and must not be printed or exported
as step details. Use `discordScenarioContext.sutAccountId` when targeting the
leased account; never insert a personal bot/account identity.

For custom runtime/provider experiments, use the existing `--provider-mode` and
model flags shown by `pnpm openclaw qa discord --help`. Keep the model reference
operator-supplied. A mock provider proves deterministic request/response plumbing,
not model competence. A native command can legitimately produce no provider
request; a claimed model/tool turn cannot.

## Cancellation and evidence integrity

Native actions check the scenario signal, stopped state, and current lease
health before effects and after awaits. REST calls have bounded timeouts and no
automatic write retry. Recorder heartbeat ACK loss, disconnect, invalid session,
and authorization failure end reliable observation; there is no silent reconnect
that claims a continuous recording. A new run gets a new lease/readiness check.

Each scenario writes a mode-0700 `discord-e2e-<run-id>` directory and a mode-0600
`events.ndjson` file beneath its reported output directory:

- `source: native-api`: operation intent, response, accepted receipt, or failure.
  An intent without accepted ownership remains unresolved; response arrival alone
  does not grant ownership when the identity/channel differs.
- `source: ownership` / `correlation`: receipt-to-message and trigger-to-SUT joins,
  including events that arrived before the REST response.
- `source: discord-gateway`: actual message/create/update/delete/bulk-delete,
  reaction, and typing observations with sequence, actor, channel, and available
  trigger/reference IDs. Authorless revisions/deletions retain prior identity.
- `source: recorder`: continuity through recorder close, not a claim that every
  platform interaction is observable.
- `source: cleanup`: success/failure, unresolved operation IDs, and owned-thread
  dispositions (`delete`, `archive`, or failure). Archival leaves a retained
  thread and is not deletion.

The recorder keeps leased-bot message content, not unrelated authors' content.
Files still contain private identities and QA message text. Preserve these and
the suite's Gateway/provider evidence until the reproduction or review is done;
share only a redacted excerpt tied to the claim. No secrets belong in CLI argv,
YAML, shell tracing, stdout, or committed evidence.

## Cleanup and recovery limits

Normal teardown stops new actions and joins in-flight requests while the recorder
keeps observing under lease authority. After the owned Gateway stops, it closes
the recorder, removes receipt-owned reactions/messages/uploads, and disposes owned
threads while the lease remains renewed. Only then does it stop the heartbeat
and release the lease. Explicitly correlated SUT messages use the leased SUT's
own token for deletion; unrelated SUT traffic remains untouched. Existing curated
suite runs do not silently inherit this new cleanup policy.

If cancellation races a successful response, the receipt is saved before the
post-await cancellation error so post-stop cleanup can still remove that object.
If lease authority expires, native cleanup stops too: a matching old token or
object ID is not permission to mutate after lease loss. The suite reports
incomplete cleanup and preserves evidence rather than claiming success.

For an uncertain write, recorder gap, or cleanup failure:

1. Preserve the private output directory and the exact failed phase. Do not
   automatically rerun a scenario that may resend an accepted write.
2. Reconcile the saved operation/receipt IDs against the QA fixture through its
   authorized owner. A new lease does not automatically inherit the old run's
   ownership. Ambiguous objects remain untouched.
3. Report any retained message, uploaded attachment, or archived thread explicitly.
   No channel sweep, bulk deletion, new permission grants, user-token automation,
   or arbitrary process termination is part of recovery.
4. After the owner resolves the cause, start a fresh isolated run and keep the
   failed evidence separate. Do not rotate unchanged credentials to hunt for a
   passing report.
