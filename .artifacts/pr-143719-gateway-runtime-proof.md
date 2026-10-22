# PR #143719 redacted runtime proof

- head: c25b4b8c1d985d5832e09dd170d6b3736e7be1c3
- transport: real in-process Gateway server + authenticated WebSocket client
- storage: per-agent SQLite session store (`session_nodes`)

```text
sqlite.before: {"basename":"sessions.sqlite","sessionRows":3}

fresh-child-pin: {"accepted":true,"pinned":true}

ordinary-child-pin: {"accepted":false,"rejected":true,"error":"cannot pin a child session; pin its parent session instead"}

global-shelf-projection: {"pinnedKeys":["agent:main:dashboard:fresh","agent:main:dashboard:existing","agent:main:dashboard:stale"]}

reload-restart-persistence: {"pinnedKeys":["agent:main:dashboard:fresh","agent:main:dashboard:existing","agent:main:dashboard:stale"]}

stale-pin-maintenance: {"cleanupAccepted":true,"cleanup":{"agentId":"main","storePath":"sessions.sqlite","mode":"enforce","dryRun":false,"beforeCount":6,"afterCount":6,"missing":0,"dmScopeRetired":0,"modelRunPruned":0,"archived":0,"capArchived":0,"pruned":0,"capped":0,"unreferencedArtifacts":{"scannedFiles":3,"removedFiles":0,"freedBytes":0,"olderThanMs":2592000000},"diskBudget":{"totalBytesBefore":1033936,"totalBytesAfter":1033936,"removedFiles":0,"removedEntries":0,"freedBytes":0,"maxBytes":10737418240,"highWaterBytes":8589934592,"overBudget":false},"wouldMutate":false,"applied":true,"appliedCount":6},"staleStillPresent":true,"staleStillPinned":true}

sqlite.persistence: {"freshPinned":true,"existingPinned":true,"stalePinned":true,"ordinaryPinned":false}

```
