---
summary: "Session lock watchdog for detecting and recovering stuck locks"
title: "Session Lock Watchdog"
---

# Session Lock Watchdog

**Issue**: #18060

Session locks can become stuck when processes crash or hang while holding locks, preventing all future operations on that session. A watchdog is needed to detect and recover from stuck locks automatically.

## Understanding Session Locks

**Purpose:** Prevent concurrent modifications to session state

**Lock types in OpenClaw:**

- **Message lock**: Prevents concurrent message appends
- **State lock**: Prevents concurrent state updates
- **File lock**: Prevents concurrent session file writes
- **Turn lock**: Prevents concurrent turn processing

**Normal lock lifecycle:**

```
1. Acquire lock
2. Perform operation (read/modify/write)
3. Release lock
```

**Stuck lock lifecycle:**

```
1. Acquire lock
2. Perform operation
3. ⚠️ Process crashes → lock never released
4. All future operations blocked indefinitely
```

## Stuck Lock Scenarios

### Scenario 1: Process Crash While Holding Lock

**What happens:**

```
T1: Process A acquires session lock
T2: Process A starts writing session state
T3: Process A crashes (OOM, SIGKILL, power loss)
T4: Lock never released
T5: Process B tries to acquire lock → hangs forever
```

**Impact:** Session permanently inaccessible

### Scenario 2: Deadlock

**What happens:**

```
Process A: Acquire session lock S1 → waiting for S2
Process B: Acquire session lock S2 → waiting for S1
Result: Both processes stuck forever
```

**Impact:** Multiple sessions blocked

### Scenario 3: Hung Operation

**What happens:**

```
T1: Acquire lock
T2: Call external API (timeout: none)
T3: API never responds
T4: Process stuck holding lock forever
```

**Impact:** Session blocked until manual intervention

### Scenario 4: Lock File Orphaned

**What happens:**

```
T1: Create lock file: /tmp/openclaw-session-abc123.lock
T2: Process crashes
T3: Lock file remains on disk
T4: All processes see lock file → assume lock held
```

**Impact:** Session locked despite no active holder

## Detection

### Symptom 1: Session Operations Hang

**User report:**

```
User: "Send message"
Agent: *spinner forever, no response*
User: *Ctrl+C*
User: "Try again"
Agent: *spinner forever again*
```

**In logs:**

```
[info]  Acquiring session lock for session_abc123...
[warn]  Lock acquisition timeout (30s), retrying...
[warn]  Lock acquisition timeout (30s), retrying...
[error] Failed to acquire lock after 5 attempts
```

### Symptom 2: Lock File Exists But No Owner

**Check lock files:**

```bash
ls -la /tmp/openclaw-*.lock
-rw-r--r-- 1 user user 42 Feb 18 15:32 openclaw-session-abc123.lock

# Check PID in lock file
cat /tmp/openclaw-session-abc123.lock
{"pid":12345,"acquired":"2026-02-18T15:32:00Z"}

# Check if PID still running
ps -p 12345
# No such process
```

**Result:** Lock file orphaned (owner dead)

### Symptom 3: Gateway Restart Required

**User report:**

```
User: "Message not sending"
Admin: *Restart gateway*
systemctl --user restart openclaw-gateway
User: "Works now!"
```

**Cause:** Restart cleared stuck locks

### Symptom 4: Lock Age Anomaly

**Check lock age:**

```bash
# Lock files older than expected
find /tmp -name "openclaw-*.lock" -mtime +1 -ls
# Lock from 3 days ago still present
```

## Watchdog Implementation

### Approach 1: Timeout-Based Watchdog

**Concept:** Locks have maximum hold time

**Implementation:**

```typescript
class SessionLockManager {
  private locks = new Map<string, LockInfo>();
  private readonly MAX_LOCK_AGE_MS = 300000; // 5 minutes

  async acquireLock(sessionId: string): Promise<void> {
    const existing = this.locks.get(sessionId);

    if (existing) {
      const age = Date.now() - existing.acquiredAt;

      if (age > this.MAX_LOCK_AGE_MS) {
        logger.warn(`Lock for ${sessionId} held for ${age}ms, forcibly releasing`);
        await this.forceRelease(sessionId);
      } else {
        throw new LockHeldError(`Session locked by ${existing.owner}`);
      }
    }

    this.locks.set(sessionId, {
      acquiredAt: Date.now(),
      owner: process.pid,
    });
  }
}
```

**Pros:** Simple, catches most stuck locks

**Cons:** May release locks from legitimate long operations

### Approach 2: PID-Based Watchdog

**Concept:** Verify lock owner still alive

**Implementation:**

```typescript
async function checkLockOwner(lockInfo: LockInfo): Promise<boolean> {
  try {
    // Send signal 0 to check if process exists
    process.kill(lockInfo.pid, 0);
    return true; // Process alive
  } catch (error) {
    if (error.code === "ESRCH") {
      return false; // Process dead
    }
    throw error;
  }
}

async function acquireLock(sessionId: string): Promise<void> {
  const lockFile = `/tmp/openclaw-session-${sessionId}.lock`;

  if (await fs.exists(lockFile)) {
    const lockInfo = JSON.parse(await fs.readFile(lockFile));

    if (!(await checkLockOwner(lockInfo))) {
      logger.warn(`Lock owner PID ${lockInfo.pid} dead, removing orphaned lock`);
      await fs.unlink(lockFile);
    }
  }

  // Acquire lock
  await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, acquired: new Date() }));
}
```

**Pros:** Accurate, doesn't break long operations

**Cons:** Only works for same-machine locks

### Approach 3: Heartbeat-Based Watchdog

**Concept:** Lock owner must send periodic heartbeats

**Implementation:**

```typescript
class SessionLockManager {
  private locks = new Map<string, LockInfo>();
  private readonly HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds
  private readonly HEARTBEAT_TIMEOUT_MS = 30000; // 30 seconds

  constructor() {
    // Watchdog checks heartbeats every 10 seconds
    setInterval(() => this.checkHeartbeats(), this.HEARTBEAT_INTERVAL_MS);
  }

  async acquireLock(sessionId: string): Promise<string> {
    const lockId = randomUUID();
    this.locks.set(sessionId, {
      lockId,
      owner: process.pid,
      lastHeartbeat: Date.now(),
    });
    return lockId;
  }

  async heartbeat(sessionId: string, lockId: string): Promise<void> {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.lastHeartbeat = Date.now();
    }
  }

  private async checkHeartbeats(): Promise<void> {
    const now = Date.now();

    for (const [sessionId, lock] of this.locks) {
      const age = now - lock.lastHeartbeat;

      if (age > this.HEARTBEAT_TIMEOUT_MS) {
        logger.warn(`Lock for ${sessionId} missed heartbeats, releasing`);
        await this.forceRelease(sessionId);
      }
    }
  }
}
```

**Pros:** Catches hung operations, not just crashes

**Cons:** Adds heartbeat overhead

### Approach 4: Distributed Lock with TTL

**Concept:** Use Redis/Valkey with automatic expiration

**Implementation:**

```typescript
class RedisLockManager {
  private redis: Redis;
  private readonly LOCK_TTL_SEC = 300; // 5 minutes

  async acquireLock(sessionId: string): Promise<string> {
    const lockKey = `session:lock:${sessionId}`;
    const lockValue = randomUUID();

    // SET NX (only if not exists) + EX (expiration)
    const acquired = await this.redis.set(lockKey, lockValue, "NX", "EX", this.LOCK_TTL_SEC);

    if (!acquired) {
      throw new LockHeldError("Session locked");
    }

    return lockValue;
  }

  async releaseLock(sessionId: string, lockValue: string): Promise<void> {
    const lockKey = `session:lock:${sessionId}`;

    // Only delete if value matches (prevent releasing others' locks)
    await this.redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then
         return redis.call("del", KEYS[1])
       else
         return 0
       end`,
      1,
      lockKey,
      lockValue,
    );
  }
}
```

**Pros:** Automatic expiration, works across machines

**Cons:** Requires Redis/Valkey dependency

## Diagnostic Tools

### Check Active Locks

**Script:**

```bash
#!/bin/bash
# check-session-locks.sh

echo "🔒 Session Lock Status"
echo "====================="
echo ""

LOCK_DIR="/tmp"
OPENCLAW_LOCKS=$(find "$LOCK_DIR" -name "openclaw-session-*.lock" 2>/dev/null)

if [ -z "$OPENCLAW_LOCKS" ]; then
  echo "✅ No session locks active"
  exit 0
fi

STUCK_LOCKS=0
ACTIVE_LOCKS=0

for lock_file in $OPENCLAW_LOCKS; do
  SESSION_ID=$(basename "$lock_file" .lock | sed 's/openclaw-session-//')
  LOCK_DATA=$(cat "$lock_file" 2>/dev/null)

  if [ -z "$LOCK_DATA" ]; then
    echo "⚠️ Empty lock file: $lock_file"
    ((STUCK_LOCKS++))
    continue
  fi

  PID=$(echo "$LOCK_DATA" | jq -r '.pid // empty')
  ACQUIRED=$(echo "$LOCK_DATA" | jq -r '.acquired // empty')

  if [ -z "$PID" ]; then
    echo "⚠️ Invalid lock file: $lock_file (missing PID)"
    ((STUCK_LOCKS++))
    continue
  fi

  # Check if process still running
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "❌ Orphaned lock: $SESSION_ID"
    echo "   PID: $PID (dead)"
    echo "   Acquired: $ACQUIRED"
    echo "   File: $lock_file"
    ((STUCK_LOCKS++))
  else
    # Check lock age
    if [ -n "$ACQUIRED" ]; then
      ACQUIRED_SEC=$(date -d "$ACQUIRED" +%s 2>/dev/null || echo "0")
      NOW_SEC=$(date +%s)
      AGE_SEC=$((NOW_SEC - ACQUIRED_SEC))
      AGE_MIN=$((AGE_SEC / 60))

      if [ "$AGE_SEC" -gt 300 ]; then
        echo "⚠️ Long-held lock: $SESSION_ID"
        echo "   PID: $PID (running)"
        echo "   Age: ${AGE_MIN} minutes"
        echo "   Acquired: $ACQUIRED"
        ((STUCK_LOCKS++))
      else
        echo "✅ Active lock: $SESSION_ID (${AGE_SEC}s old, PID $PID)"
        ((ACTIVE_LOCKS++))
      fi
    fi
  fi
  echo ""
done

echo "Summary"
echo "======="
echo "Active locks: $ACTIVE_LOCKS"
echo "Stuck locks: $STUCK_LOCKS"

if [ "$STUCK_LOCKS" -gt 0 ]; then
  echo ""
  echo "To clear stuck locks:"
  echo "  ./scripts/doctor/clear-session-locks.sh"
fi
```

### Clear Stuck Locks

**Script:**

```bash
#!/bin/bash
# clear-session-locks.sh

echo "🧹 Clearing Stuck Session Locks"
echo "==============================="
echo ""

LOCK_DIR="/tmp"
CLEARED=0

for lock_file in "$LOCK_DIR"/openclaw-session-*.lock; do
  if [ ! -f "$lock_file" ]; then
    continue
  fi

  LOCK_DATA=$(cat "$lock_file" 2>/dev/null)
  PID=$(echo "$LOCK_DATA" | jq -r '.pid // empty')

  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    SESSION_ID=$(basename "$lock_file" .lock | sed 's/openclaw-session-//')
    echo "Clearing orphaned lock: $SESSION_ID"
    rm "$lock_file"
    ((CLEARED++))
  fi
done

if [ "$CLEARED" -eq 0 ]; then
  echo "✅ No stuck locks found"
else
  echo ""
  echo "✅ Cleared $CLEARED stuck lock(s)"
  echo ""
  echo "Restart gateway to ensure clean state:"
  echo "  systemctl --user restart openclaw-gateway"
fi
```

## Prevention Best Practices

### 1. Always Use Try-Finally

**Pattern:**

```typescript
async function updateSession(sessionId: string) {
  const lockId = await lockManager.acquireLock(sessionId);

  try {
    // Perform operations
    const session = await loadSession(sessionId);
    session.messages.push(newMessage);
    await saveSession(session);
  } finally {
    // Always release, even on error
    await lockManager.releaseLock(sessionId, lockId);
  }
}
```

### 2. Set Operation Timeouts

**Pattern:**

```typescript
async function updateSession(sessionId: string) {
  const lockId = await lockManager.acquireLock(sessionId);

  try {
    // Set timeout for entire operation
    await withTimeout(
      async () => {
        const session = await loadSession(sessionId);
        session.messages.push(newMessage);
        await saveSession(session);
      },
      30000, // 30 second timeout
    );
  } finally {
    await lockManager.releaseLock(sessionId, lockId);
  }
}
```

### 3. Implement Lock Heartbeats

**Pattern:**

```typescript
async function longOperation(sessionId: string) {
  const lockId = await lockManager.acquireLock(sessionId);

  // Send heartbeat every 10 seconds
  const heartbeatInterval = setInterval(() => {
    lockManager.heartbeat(sessionId, lockId);
  }, 10000);

  try {
    // Long-running operation
    await performExpensiveTask();
  } finally {
    clearInterval(heartbeatInterval);
    await lockManager.releaseLock(sessionId, lockId);
  }
}
```

### 4. Monitor Lock Age

**Alert on old locks:**

```bash
# Cron job to check lock age
*/5 * * * * /path/to/check-session-locks.sh | grep "⚠️\|❌" && \
  echo "Stuck locks detected" | mail -s "OpenClaw Alert" admin@example.com
```

### 5. Graceful Shutdown

**Release locks on shutdown:**

```typescript
process.on("SIGTERM", async () => {
  logger.info("Shutting down, releasing locks...");

  // Release all held locks
  await lockManager.releaseAll();

  // Then exit
  process.exit(0);
});
```

## Configuration

**Recommended settings:**

```json
{
  "gateway": {
    "sessionLocking": {
      "enabled": true,
      "maxLockAge": 300000,
      "watchdogInterval": 10000,
      "heartbeatRequired": true,
      "autoRelease": {
        "enabled": true,
        "onOwnerDeath": true,
        "onTimeout": true
      }
    }
  }
}
```

## Testing Lock Watchdog

### Test 1: Orphaned Lock Recovery

**Script:**

```bash
# Create fake orphaned lock
cat > /tmp/openclaw-session-test.lock <<EOF
{"pid":99999,"acquired":"2026-02-18T10:00:00Z"}
EOF

# Try to acquire lock
curl -X POST http://localhost:3030/api/chat \
  -d '{"sessionId":"test","message":"hello"}'

# Should detect PID 99999 is dead and clear lock
```

**Expected:** Lock cleared, operation succeeds

**Failure:** Operation hangs (watchdog not working)

### Test 2: Lock Timeout

**Script:**

```typescript
// Acquire lock and never release
const lockId = await lockManager.acquireLock("test-session");

// Wait 6 minutes (exceeds 5 minute timeout)
await sleep(360000);

// Try to acquire lock from another process
// Should succeed due to timeout watchdog
const lockId2 = await lockManager.acquireLock("test-session");
```

**Expected:** Second acquire succeeds after timeout

**Failure:** Second acquire hangs forever

### Test 3: Heartbeat Failure

**Script:**

```typescript
// Acquire lock
const lockId = await lockManager.acquireLock("test-session");

// Start heartbeat
const interval = setInterval(() => {
  lockManager.heartbeat("test-session", lockId);
}, 10000);

// Stop heartbeat (simulate hung process)
clearInterval(interval);

// Wait 35 seconds (exceeds 30 second heartbeat timeout)
await sleep(35000);

// Try to acquire lock
// Should succeed due to missed heartbeats
const lockId2 = await lockManager.acquireLock("test-session");
```

**Expected:** Lock released after missed heartbeats

**Failure:** Lock stuck despite no heartbeats

## Long-Term Fix

**Status:** Core code changes required

**PR available:** Not yet (as of 2026.2.19)

**Required changes:**

1. Implement timeout-based watchdog
2. Add PID-based orphan detection
3. Implement heartbeat system
4. Add lock age monitoring
5. Graceful shutdown with lock release
6. Diagnostic endpoints (list locks, force clear)
7. Configuration for watchdog behavior

**Complexity:** Medium (requires careful testing)

**Risk:** Medium (lock management is critical)

## Related Issues

- **#18060**: Session lock watchdog (this issue)
- **#20797**: PTY race conditions
- **#6766**: Registry write races
- **#20769**: Reset-model races

## Related Documentation

- [Session Management](/concepts/sessions)
- [Concurrency Control](/gateway/concurrency)
- [Gateway Configuration](/gateway/configuration)

## External Resources

- File Locking: <https://man7.org/linux/man-pages/man2/flock.2.html>
- Redis Distributed Locks: <https://redis.io/docs/manual/patterns/distributed-locks/>
- Issue #18060: <https://github.com/openclaw/openclaw/issues/18060>

---

**Last updated**: February 19, 2026
**Status**: Diagnostic tools available, core fix required
