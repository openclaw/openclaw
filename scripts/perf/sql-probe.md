# SQL precondition probe workload

Acceptance rule registered before the first run (base 285029f87941081e3c46f78b8bc77c29f59d587f).

The workload exercises three existing owners with synthetic state: single-use pairing join-code redemption (successful, missing, expired and malformed), selected proxy capture session deletion (existing, missing and shared payload), and outbound progress append across its 200,000-row retention cap with sequence gaps. Preserve results, error precedence, authority, transactions, expiry consumption, single use, blob custody and the retained row boundary.

Count executed statements first. On an initialized owner, join-code redemption must fall from three table statements to two per action; selected capture deletion must remove exactly two COUNT queries per nonempty ID request; progress overflow must fall from five table statements to four. Worker requests and main-thread work must not increase. Deterministic count assertions must fail on unchanged production and pass after the change; outcome assertions must pass on both. Existing rollback and real HTTP pairing tests remain mandatory.

Use the existing owner tests as committed fixtures:

- `src/infra/database-engine/sql-probe.conformance.test.ts` and `src/infra/device-pairing-join-code.worker.test.ts`
- `src/proxy-capture/store.sqlite.test.ts` and `store.async.test.ts`
- `src/audit/message-delivery-progress-store.test.ts` and `src/infra/database-engine/message-progress-retention.conformance.test.ts`
- `src/gateway/server-http.device-pairing-join.test.ts`

Run real isolated Gateway transport with the frozen campaign observer, including a warm non-regression workload. Keep cold setup and warm actions separate; report statements/requests/MAIN and operation attribution. Run three alternating baseline/candidate frozen pairs when admission load is below 64; otherwise use one pair under the campaign exception. Report median, p95 and range for repeated actions. Record per-thread Node CPU profiles without claiming speed from elapsed worker-service times. Wall-clock or CPU A/B claims require the timing lock, load below 24 and at least five interleaved samples per arm; otherwise report only counts/profile attribution and explicitly leave latency unmeasured. Any 20% increase is investigated and attributed, never called spread.

PostgreSQL proof must exercise RETURNING through the engine-selected Kysely dialect, deletion affected counts and empty/nonempty scalar cutoff outcomes inside existing write transactions. No schema or retention changes are authorized.
