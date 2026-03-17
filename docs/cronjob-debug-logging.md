# Debug Logging cho Cronjob Execution

## ✅ Changes Applied

### **Files Modified:**

**File:** `src/cron/service/timer.ts`

### **Added Debug Logs:**

#### **1. Timer Tick Logging**

```typescript
// onTimer() - Beginning of timer tick
state.deps.log.info(
  {
    totalJobs: state.store?.jobs.length ?? 0,
    enabledJobs: state.store?.jobs.filter((j) => j.enabled).length ?? 0,
    nowMs: now,
    nextWakeAtMs: nextWakeAtMs(state),
  },
  `cron: [ON-TIMER] Starting timer tick`,
);
```

#### **2. Due Jobs Discovery**

```typescript
// findDueJobs() - Scanning for due jobs
state.deps.log.debug(
  {
    totalJobs: state.store.jobs.length,
    nowMs: now,
    nowIso: new Date(now).toISOString(),
  },
  `cron: [FIND-DUE-JOBS] Scanning for due jobs`,
);

// After scanning
state.deps.log.debug(
  {
    dueCount: dueJobs.length,
    dueJobIds: dueJobs.map((j) => j.id),
  },
  `cron: [FIND-DUE-JOBS] Found ${dueJobs.length} due jobs`,
);
```

#### **3. Due Jobs Details**

```typescript
// onTimer() - After finding due jobs
state.deps.log.info(
  {
    dueJobsCount: due.length,
    dueJobIds: due.map((j) => j.id),
    dueJobs: due.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      scheduleKind: j.schedule.kind,
      nextRunAtMs: j.state.nextRunAtMs,
      lastRunAtMs: j.state.lastRunAtMs,
      lastRunStatus: j.state.lastRunStatus,
      runningAtMs: j.state.runningAtMs,
      hasWorkflowChain: j.description?.includes("__wf_chain__"),
    })),
  },
  `cron: [ON-TIMER] Found due jobs`,
);
```

#### **4. Job Execution Details**

```typescript
// runDueJob() - Before execution
state.deps.log.info(
  {
    jobId: job.id,
    jobName: job.name,
    jobEnabled: job.enabled,
    scheduleKind: job.schedule.kind,
    scheduleExpr: job.schedule.kind === "cron" ? job.schedule.expr : undefined,
    nextRunAtMs: job.state.nextRunAtMs,
    runningAtMs: job.state.runningAtMs,
    lastRunAtMs: job.state.lastRunAtMs,
    lastRunStatus: job.state.lastRunStatus,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payloadKind: job.payload.kind,
    payloadMessage:
      job.payload.kind === "agentTurn" ? job.payload.message?.substring(0, 100) : undefined,
    hasWorkflowChain: job.description?.includes("__wf_chain__"),
    workflowChainPreview: job.description?.includes("__wf_chain__")
      ? job.description.substring(
          job.description.indexOf("__wf_chain__"),
          job.description.indexOf("__wf_chain__") + 200,
        )
      : undefined,
  },
  `cron: [RUN-DUE-JOB] Starting execution`,
);
```

#### **5. Job Execution Result**

```typescript
// runDueJob() - After execution
state.deps.log.info(
  {
    jobId: job.id,
    jobName: job.name,
    status: result.status,
    durationMs: state.deps.nowMs() - startedAt,
    delivered: result.delivered,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    error: result.error,
  },
  `cron: [RUN-DUE-JOB] Execution completed`,
);
```

#### **6. Non-Runnable Jobs**

```typescript
// collectRunnableJobs() - Why job is not runnable
if (!isRunnable && job.enabled) {
  state.deps.log.debug(
    {
      jobId: job.id,
      jobName: job.name,
      enabled: job.enabled,
      scheduleKind: job.schedule.kind,
      nextRunAtMs: job.state.nextRunAtMs,
      runningAtMs: job.state.runningAtMs,
      lastRunAtMs: job.state.lastRunAtMs,
      lastRunStatus: job.state.lastRunStatus,
      nowMs,
      timeUntilDue:
        typeof job.state.nextRunAtMs === "number" ? job.state.nextRunAtMs - nowMs : undefined,
    },
    `cron: [COLLECT-RUNNABLE] Job not runnable`,
  );
}
```

## 🧪 Testing & Debugging

### **1. Watch Logs Real-time**

```bash
# Watch all cron logs
tail -f ~/.openclaw/logs/gateway.log | grep -E "cron: \[.*\]"

# Watch specific tags
tail -f ~/.openclaw/logs/gateway.log | grep -E "ON-TIMER|FIND-DUE-JOBS|RUN-DUE-JOB"

# Watch with jq for pretty JSON
tail -f ~/.openclaw/logs/gateway.log | grep "cron: \[" | jq -R 'split(" | ") | .[1]'
```

### **2. Expected Log Output**

#### **Timer Tick (every ~60s):**

```log
2026-03-17T12:00:00.000+07:00 cron: [ON-TIMER] Starting timer tick | {"totalJobs":5,"enabledJobs":3,"nowMs":1773719900000,"nextWakeAtMs":1773719960000}
```

#### **Finding Due Jobs:**

```log
2026-03-17T12:00:00.100+07:00 cron: [FIND-DUE-JOBS] Scanning for due jobs | {"totalJobs":5,"nowMs":1773719900000,"nowIso":"2026-03-17T05:00:00.000Z"}
2026-03-17T12:00:00.150+07:00 cron: [FIND-DUE-JOBS] Found 2 due jobs | {"dueCount":2,"dueJobIds":["job-1","job-2"]}
2026-03-17T12:00:00.200+07:00 cron: [ON-TIMER] Found due jobs | {"dueJobsCount":2,"dueJobs":[{"id":"job-1","name":"Daily Digest","enabled":true,"scheduleKind":"cron","nextRunAtMs":1773719900000,"hasWorkflowChain":true}]}
```

#### **Job Execution:**

```log
2026-03-17T12:00:00.300+07:00 cron: [ON-TIMER] Starting execution of due jobs | {"dueJobsCount":2,"nowMs":1773719900000}
2026-03-17T12:00:00.400+07:00 cron: [RUN-DUE-JOB] Starting execution | {"jobId":"job-1","jobName":"Daily Digest","jobEnabled":true,"scheduleKind":"cron","scheduleExpr":"0 8 * * *","hasWorkflowChain":true,"workflowChainPreview":"__wf_chain__:[{\"nodeId\":\"step1\",\"actionType\":\"agent-prompt\"..."}
2026-03-17T12:00:00.500+07:00 cron: [RUN-DUE-JOB] Executing job with timeout | {"jobId":"job-1","jobName":"Daily Digest","timeoutMs":300000}
```

#### **Job Completion:**

```log
2026-03-17T12:05:00.000+07:00 cron: [RUN-DUE-JOB] Execution completed | {"jobId":"job-1","jobName":"Daily Digest","status":"ok","durationMs":279600,"delivered":true,"sessionId":"abc-123","sessionKey":"agent:main:cron:job-1"}
```

#### **Non-Runnable Jobs (Debug Level):**

```log
2026-03-17T12:00:00.100+07:00 cron: [COLLECT-RUNNABLE] Job not runnable | {"jobId":"job-3","jobName":"Weekly Report","enabled":true,"scheduleKind":"cron","nextRunAtMs":1774324800000,"nowMs":1773719900000,"timeUntilDue":604900000}
```

### **3. Debug Specific Issues**

#### **Issue: Job Not Running**

```bash
# Check if job is enabled
openclaw cron list | jq '.[] | select(.id == "job-id") | {id, name, enabled, nextRunAtMs}'

# Watch why it's not runnable
tail -f ~/.openclaw/logs/gateway.log | grep "job-id" | grep "not runnable"

# Check next run time
node -e "console.log(new Date(<nextRunAtMs>).toISOString())"
```

#### **Issue: Workflow Not Executing**

```bash
# Check if workflow chain is detected
tail -f ~/.openclaw/logs/gateway.log | grep "hasWorkflowChain.*true"

# Watch workflow execution
tail -f ~/.openclaw/logs/gateway.log | grep -E "workflow:|RUN-DUE-JOB.*workflow"

# Check workflow chain preview
tail -f ~/.openclaw/logs/gateway.log | grep "workflowChainPreview" | head -1 | jq -R 'split(" | ")[1] | fromjson?'
```

#### **Issue: Job Taking Too Long**

```bash
# Watch execution duration
tail -f ~/.openclaw/logs/gateway.log | grep "durationMs"

# Check timeout
tail -f ~/.openclaw/logs/gateway.log | grep "timeoutMs"

# Check if job timed out
tail -f ~/.openclaw/logs/gateway.log | grep "timed out"
```

### **4. Log Analysis Script**

```bash
#!/bin/bash
# File: scripts/analyze-cron-logs.sh

LOG_FILE="$HOME/.openclaw/logs/gateway.log"

echo "=== Cron Timer Ticks (Last 10) ==="
grep "ON-TIMER] Starting timer tick" "$LOG_FILE" | tail -10

echo
echo "=== Due Jobs Found (Last 10) ==="
grep "ON-TIMER] Found due jobs" "$LOG_FILE" | tail -10

echo
echo "=== Job Executions (Last 10) ==="
grep "RUN-DUE-JOB] Starting execution" "$LOG_FILE" | tail -10

echo
echo "=== Execution Results ==="
grep "RUN-DUE-JOB] Execution completed" "$LOG_FILE" | tail -10 | jq -R 'split(" | ") | {timestamp: .[0], level: .[1], message: .[2], data: (.[3] | fromjson?)}'

echo
echo "=== Failed Jobs ==="
grep "RUN-DUE-JOB] Job failed" "$LOG_FILE" | tail -10

echo
echo "=== Non-Runnable Jobs (Last Hour) ==="
grep "COLLECT-RUNNABLE] Job not runnable" "$LOG_FILE" | tail -20 | jq -R 'split(" | ") | .[3] | fromjson? | {jobId, jobName, timeUntilDue: (.timeUntilDue / 60000 | floor | "\(.) min")}'
```

### **5. Real-time Monitoring Dashboard**

```bash
# Create a monitoring script
cat > /tmp/cron-monitor.sh << 'EOF'
#!/bin/bash
clear
echo "🔍 OpenClaw Cronjob Monitor"
echo "=========================="
echo
echo "Press Ctrl+C to exit"
echo
tail -f ~/.openclaw/logs/gateway.log | while read line; do
  if echo "$line" | grep -q "ON-TIMER]"; then
    echo -e "\n⏰ $(date '+%H:%M:%S') $line" | grep -o '{.*}' | jq '{totalJobs, enabledJobs}'
  elif echo "$line" | grep -q "FIND-DUE-JOBS]"; then
    echo -e "🔍 $(date '+%H:%M:%S') $line" | grep -o '{.*}' | jq '{dueCount}'
  elif echo "$line" | grep -q "RUN-DUE-JOB] Starting"; then
    echo -e "🚀 $(date '+%H:%M:%S') $line" | grep -o '{.*}' | jq '{jobId, jobName, hasWorkflowChain}'
  elif echo "$line" | grep -q "RUN-DUE-JOB] Execution completed"; then
    echo -e "✅ $(date '+%H:%M:%S') $line" | grep -o '{.*}' | jq '{jobId, status, durationMs}'
  fi
done
EOF

chmod +x /tmp/cron-monitor.sh
/tmp/cron-monitor.sh
```

## 📊 Log Tags Reference

| Tag                  | Description           | Log Level |
| -------------------- | --------------------- | --------- |
| `[ON-TIMER]`         | Timer tick started    | INFO      |
| `[FIND-DUE-JOBS]`    | Scanning for due jobs | DEBUG     |
| `[COLLECT-RUNNABLE]` | Job runnable check    | DEBUG     |
| `[RUN-DUE-JOB]`      | Job execution         | INFO      |

## 🔍 Common Debug Scenarios

### **Scenario 1: Job Not Executing**

**Check:**

1. Is job enabled? → Check `enabled: true` in logs
2. Is nextRunAtMs in the past? → Check `timeUntilDue` (should be ≤ 0)
3. Is job already running? → Check `runningAtMs` (should be undefined)
4. Is there a workflow chain? → Check `hasWorkflowChain: true`

**Logs to watch:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep "job-id" | grep -E "not runnable|Starting execution"
```

### **Scenario 2: Workflow Chain Not Detected**

**Check:**

1. Is `__wf_chain__` in description? → Check `workflowChainPreview`
2. Is chain JSON valid? → Check logs for parse errors
3. Are steps correctly formatted? → Check workflowChainPreview content

**Logs to watch:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep "workflowChainPreview"
```

### **Scenario 3: Job Execution Timeout**

**Check:**

1. What's the timeout? → Check `timeoutMs`
2. How long did it run? → Check `durationMs`
3. What was the error? → Check `error` field

**Logs to watch:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep -E "timeout|timed out"
```

## ✅ Verification Checklist

After deploying these changes:

- [ ] Restart gateway
- [ ] Watch timer ticks (`[ON-TIMER]`)
- [ ] Verify due jobs discovery (`[FIND-DUE-JOBS]`)
- [ ] Check job execution logs (`[RUN-DUE-JOB]`)
- [ ] Verify workflow chain detection (`hasWorkflowChain`)
- [ ] Monitor execution duration (`durationMs`)
- [ ] Check error handling (failed jobs)
- [ ] Test with manual run (`openclaw cron run <job-id>`)

## 🎉 Result

**Full visibility into cronjob execution!**

- ✅ See when timer ticks
- ✅ See which jobs are due
- ✅ See why jobs are NOT runnable
- ✅ See job execution details
- ✅ See workflow chain detection
- ✅ See execution results
- ✅ See errors and timeouts

**Happy Debugging! 🔍**
