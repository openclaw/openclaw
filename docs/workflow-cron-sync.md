# Workflow → Cron Job Sync trong UI-Next

## 🎯 Vấn Đề Hiện Tại

### **Luồng hiện tại (use-workflows.ts:saveWorkflow):**

```typescript
const saveWorkflow = async (id, name, nodes, edges) => {
  // 1. Xóa cron jobs cũ
  const existingWorkflow = workflows.find(w => w.id === id);
  if (existingWorkflow?.cronJobIds) {
    for (const cronId of existingWorkflow.cronJobIds) {
      await request("cron.remove", { jobId: cronId }); // ❌ XÓA cron job
    }
  }

  // 2. Tạo cron jobs mới
  for (const trigger of triggers) {
    const jobCreate = { ... };
    const res = await request("cron.add", jobCreate); // ✅ TẠO cron job mới
    newCronJobIds.push(res.id);
  }

  // 3. Lưu workflow với cronJobIds mới
  await request("workflows.save", {
    id,
    name,
    nodes,
    edges,
    cronJobIds: newCronJobIds,
    triggerConfigs
  });
}
```

### **Vấn đề:**

1. **Mỗi lần save workflow → XÓA toàn bộ cron jobs cũ và TẠO MỚI**
   - ❌ Mất lịch sử run logs của cron jobs
   - ❌ Mất session keys cũ
   - ❌ Mất state (lastRunAtMs, nextRunAtMs, etc.)

2. **Không update cron jobs nếu chỉ sửa workflow config**
   - Nếu user chỉ sửa node trong workflow, không sửa trigger
   - Cron jobs nên được **UPDATE** thay vì **DELETE + CREATE**

3. **Không sync workflow changes vào cron job description**
   - Workflow nodes thay đổi → description thay đổi
   - Cron job không được update để phản ánh changes

## ✅ Giải Pháp Đề Xuất

### **Option 1: Update Cron Jobs (Recommended)**

**Thay vì xóa + tạo mới, UPDATE cron jobs hiện có:**

```typescript
const saveWorkflow = async (id, name, nodes, edges) => {
  const existingWorkflow = workflows.find((w) => w.id === id);
  const oldCronJobIds = existingWorkflow?.cronJobIds ?? [];
  const newCronJobIds: string[] = [];

  // Process all triggers
  const triggers = nodes.filter((n) => n.type === "trigger");

  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];
    const chain = extractChainFromTrigger(trigger.id, nodes, edges);
    const description = `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 2)}`;

    // Build cron job config
    const jobConfig = {
      name: `Workflow: ${name}`,
      description,
      schedule: { kind: "cron", expr: trigger.data.cronExpr },
      // ... other fields
    };

    // ✅ UPDATE nếu cron job đã tồn tại
    const existingCronJobId = oldCronJobIds[i];
    if (existingCronJobId) {
      await request("cron.update", {
        jobId: existingCronJobId,
        patch: jobConfig,
      });
      newCronJobIds.push(existingCronJobId);
    }
    // ✅ CREATE nếu là cron job mới
    else {
      const res = await request("cron.add", jobConfig);
      newCronJobIds.push(res.id);
    }
  }

  // Xóa cron jobs thừa (nếu user xóa trigger)
  const jobsToDelete = oldCronJobIds.slice(triggers.length);
  for (const jobId of jobsToDelete) {
    await request("cron.remove", { jobId });
  }

  // Save workflow
  await request("workflows.save", {
    id,
    name,
    nodes,
    edges,
    cronJobIds: newCronJobIds,
    triggerConfigs,
  });
};
```

### **Option 2: Smart Sync (Better UX)**

**Chỉ update khi có changes:**

```typescript
const saveWorkflow = async (id, name, nodes, edges) => {
  const existingWorkflow = workflows.find((w) => w.id === id);
  const oldCronJobIds = existingWorkflow?.cronJobIds ?? [];
  const newCronJobIds: string[] = [];

  const triggers = nodes.filter((n) => n.type === "trigger");

  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];
    const chain = extractChainFromTrigger(trigger.id, nodes, edges);
    const description = `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 2)}`;

    // Check if cron job needs update
    const existingCronJobId = oldCronJobIds[i];
    let needsUpdate = false;
    let patch: Record<string, unknown> = {};

    if (existingCronJobId) {
      // Get existing cron job
      const existingJob = await request("cron.list", {
        includeDisabled: true,
      }).then((res) => res.jobs.find((j) => j.id === existingCronJobId));

      if (existingJob) {
        // Check if description changed (workflow nodes changed)
        if (existingJob.description !== description) {
          needsUpdate = true;
          patch.description = description;
        }

        // Check if schedule changed
        if (existingJob.schedule.expr !== trigger.data.cronExpr) {
          needsUpdate = true;
          patch.schedule = { kind: "cron", expr: trigger.data.cronExpr };
        }

        // Check if name changed
        if (existingJob.name !== `Workflow: ${name}`) {
          needsUpdate = true;
          patch.name = `Workflow: ${name}`;
        }
      }
    }

    // Update if needed
    if (existingCronJobId && needsUpdate) {
      await request("cron.update", {
        jobId: existingCronJobId,
        patch,
      });
      newCronJobIds.push(existingCronJobId);
    }
    // Create new
    else if (!existingCronJobId) {
      const res = await request("cron.add", {
        name: `Workflow: ${name}`,
        description,
        schedule: { kind: "cron", expr: trigger.data.cronExpr },
        // ...
      });
      newCronJobIds.push(res.id);
    }
    // Keep existing (no changes)
    else {
      newCronJobIds.push(existingCronJobId);
    }
  }

  // Delete extra cron jobs
  const jobsToDelete = oldCronJobIds.slice(triggers.length);
  for (const jobId of jobsToDelete) {
    await request("cron.remove", { jobId });
  }

  // Save workflow
  await request("workflows.save", {
    id,
    name,
    nodes,
    edges,
    cronJobIds: newCronJobIds,
    triggerConfigs,
  });
};
```

## 🔧 Implementation

### **File:** `ui-next/app/workflows/use-workflows.ts`

**Current Code (line ~440):**

```typescript
// 1. Xoá các cron jobs cũ của workflow này
const existingWorkflow = workflows.find((w) => w.id === id);
if (existingWorkflow?.cronJobIds) {
  console.log("[WORKFLOW DEBUG] Removing old cron jobs:", existingWorkflow.cronJobIds);
  for (const cronId of existingWorkflow.cronJobIds) {
    try {
      await request("cron.remove", { jobId: cronId });
      console.log("[WORKFLOW DEBUG] Removed cron job:", cronId);
    } catch (e) {
      console.error("[WORKFLOW DEBUG] Failed to remove old cron job", cronId, e);
    }
  }
}
```

**Fix:**

```typescript
// 1. Get existing cron job IDs for smart update
const existingWorkflow = workflows.find((w) => w.id === id);
const oldCronJobIds = existingWorkflow?.cronJobIds ?? [];
const newCronJobIds: string[] = [];

console.log("[WORKFLOW DEBUG] Existing cron jobs:", oldCronJobIds);
```

**Then replace the cron creation logic (line ~560):**

```typescript
// === CRON TRIGGER ===
const cronExpr = (trigger.data.cronExpr as string) || "*/5 * * * *";

// Build job config
const jobConfig = {
  name: `Workflow: ${name}`,
  description,
  enabled: true,
  agentId,
  schedule: { kind: "cron", expr: cronExpr },
  sessionTarget: sessionConfig?.target || "isolated",
  wakeMode: "now",
  payload:
    firstStep.actionType === "agent-prompt"
      ? { kind: "agentTurn", message: firstStep.prompt || "Ping from Workflow" }
      : { kind: "systemEvent", text: firstStep.body || "Hello from workflow!" },
};

// Get existing cron job ID for this trigger (if any)
const existingCronJobId = oldCronJobIds[triggerIndex];

if (existingCronJobId) {
  // UPDATE existing cron job
  console.log("[WORKFLOW DEBUG] Updating existing cron job:", existingCronJobId);

  try {
    await request("cron.update", {
      jobId: existingCronJobId,
      patch: {
        name: jobConfig.name,
        description: jobConfig.description,
        schedule: jobConfig.schedule,
        // Don't update payload/message - keep existing session state
      },
    });
    console.log("[WORKFLOW DEBUG] Cron job updated:", existingCronJobId);
    newCronJobIds.push(existingCronJobId);
  } catch (e) {
    console.error("[WORKFLOW DEBUG] Failed to update cron job", existingCronJobId, e);
    throw e;
  }
} else {
  // CREATE new cron job
  console.log("[WORKFLOW DEBUG] Creating new cron job");

  try {
    const res = await request<{ id: string }>("cron.add", jobConfig);
    console.log("[WORKFLOW DEBUG] Cron job created:", res.id);
    newCronJobIds.push(res.id);
  } catch (e) {
    console.error("[WORKFLOW DEBUG] Failed to add cron job", e);
    throw e;
  }
}
```

**Delete extra cron jobs (after processing all triggers):**

```typescript
// Delete extra cron jobs (if user removed triggers)
const jobsToDelete = oldCronJobIds.slice(triggers.length);
for (const jobId of jobsToDelete) {
  console.log("[WORKFLOW DEBUG] Deleting extra cron job:", jobId);
  await request("cron.remove", { jobId });
}
```

## 📊 Benefits

### **Before (Delete + Create):**

| Action        | Result                  |
| ------------- | ----------------------- |
| Save workflow | ❌ Delete all cron jobs |
|               | ❌ Create new cron jobs |
|               | ❌ Lose run history     |
|               | ❌ Lose session state   |
|               | ❌ Lose nextRunAtMs     |

### **After (Update):**

| Action        | Result                        |
| ------------- | ----------------------------- |
| Save workflow | ✅ Update cron jobs in place  |
|               | ✅ Keep run history           |
|               | ✅ Keep session state         |
|               | ✅ Keep nextRunAtMs           |
|               | ✅ Only update changed fields |

## 🧪 Testing

### **Test 1: Update Workflow Nodes**

```bash
# 1. Create workflow with cron trigger
# 2. Note cron job ID: openclaw cron list | jq '.[] | select(.name | contains("Workflow")) | .id'
# 3. Edit workflow nodes (add/change AI Agent Prompt)
# 4. Save workflow
# 5. Check cron job still exists with same ID
# 6. Check run logs preserved: cat ~/.openclaw/cron/runs/<job-id>.jsonl
```

### **Test 2: Update Cron Schedule**

```bash
# 1. Create workflow with cron: "*/5 * * * *"
# 2. Edit workflow trigger, change to: "*/10 * * * *"
# 3. Save workflow
# 4. Check cron job updated: openclaw cron list | jq '.[] | select(.name | contains("Workflow"))'
# 5. Verify schedule.expr changed to "*/10 * * * *"
```

### **Test 3: Delete Trigger**

```bash
# 1. Create workflow with 2 cron triggers
# 2. Note both cron job IDs
# 3. Edit workflow, delete 1 trigger
# 4. Save workflow
# 5. Check: 1 cron job updated, 1 deleted
```

## ⚠️ Considerations

### **When to DELETE + CREATE:**

- User explicitly deletes cron trigger from workflow
- Workflow ID changes (new workflow)
- Cron job corrupted/invalid

### **When to UPDATE:**

- ✅ Workflow nodes change (description changes)
- ✅ Cron schedule changes (schedule changes)
- ✅ Workflow name changes (name changes)
- ✅ Session config changes (sessionTarget changes)

### **Fields to UPDATE:**

```typescript
const patch = {
  name: newName, // ✅ Update
  description: newDesc, // ✅ Update
  schedule: newSchedule, // ✅ Update
  sessionTarget: newTarget, // ✅ Update
  // Don't update:
  // - state (keep run history)
  // - payload.message (keep session context)
  // - createdAtMs (keep original)
};
```

## 📝 Implementation Checklist

- [ ] Update `use-workflows.ts` to use `cron.update` instead of `cron.remove` + `cron.add`
- [ ] Track which cron job corresponds to which trigger (by index or ID)
- [ ] Only update changed fields in cron job
- [ ] Delete extra cron jobs when triggers are removed
- [ ] Add logging for update vs create decisions
- [ ] Test with various scenarios (update nodes, update schedule, delete trigger)
- [ ] Update documentation

## 🎯 Result

**Workflow save sẽ:**

- ✅ **Preserve cron job history** - Run logs kept
- ✅ **Preserve session state** - nextRunAtMs, lastRunAtMs kept
- ✅ **Smart updates** - Only update changed fields
- ✅ **Better UX** - No unnecessary cron job churn
- ✅ **Backwards compatible** - Still creates new jobs when needed

**Happy Syncing! 🔄**
