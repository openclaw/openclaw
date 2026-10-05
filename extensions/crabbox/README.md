# Crabbox prepared workers

Dedicated Linux profiles with a known machine class and immutable setup inputs
can prepare ready workers independently of snapshot reuse. Set
`cloudWorkers.profiles.<id>.settings.warmImage` to `false` to prepare each reserve
from the provider's normal VM image. Keep the desired reserve count in
`cloudWorkers.profiles.<id>.readyWorkers` and the shared cap in
`cloudWorkers.preparedPool.maxTotal`; both can remain `3`.

OpenClaw completes normal fixed-lease allocation, project transfer and authorized
setup, and node enrollment before the worker becomes ready. The existing prepared
pool owns exact, one-use claims, expiry, capacity accounting, cancellation, and
cleanup. A retry uses the same fixed lease and verifies the retained project
completion through the normal preparation flow. Profiles using `setupEnv` are
ineligible for prepared reserves.

With `warmImage: false`, preparation does not select, inspect, fork, or capture a
checkpoint and does not renew snapshot demand. Confirmed-stop cleanup still
releases any existing allocation custody. Previously recorded snapshots remain
subject to the existing snapshot maintenance and recovery policy.

Snapshot-enabled profiles still require a Crabbox backend that supports the
requested checkpoint operations. Direct Azure Linux fixed leases use normal VM
images; they do not support checkpoint forks or native Linux capture without a
Coordinator. Disabling snapshot reuse does not bypass those provider guards.
