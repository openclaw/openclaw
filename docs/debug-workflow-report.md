# Workflow Debug Report - March 8, 2026

## 🎯 Vấn Đề Chính

**Workflow file đã được lưu đúng, nhưng cron job không chạy từng node.**

---

## 🔍 Phân Tích

### 1. Cron Expression Sai ⚠️

**Problem:**

```json
{
  "schedule": { "kind": "cron", "expr": "* * * * 5" }
}
```

Cron expression `* * * * 5` có nghĩa là **"mỗi phút vào Thứ 6"**, không phải mỗi phút!

- `* * * * *` = mỗi phút
- `* * * * 5` = mỗi phút vào Thứ 6 (day of week = 5)

**Next Run:** `2026-03-12T17:00:00.000Z` (Thứ 6, không phải hôm nay Chủ Nhật)

**Fix:**

- Đổi thành `* * * * *` để test mỗi phút
- Hoặc `*/5 * * * *` để test mỗi 5 phút
- Đã update default trong `ui-next/app/workflows/use-workflows.ts`

---

### 2. Workflow Chain Parsing ✅

**Status:** Working correctly!

Chain được encode đúng trong description:

```
__wf_chain__:[
  {"nodeId":"2","actionType":"agent-prompt","label":"AI Agent Prompt","prompt":"..."},
  {"nodeId":"dndnode_0","actionType":"agent-prompt","label":"AI Agent Prompt","prompt":"..."}
]
```

Debug script xác nhận parsing thành công:

```
✅ Workflow chain found: 2 step(s)
Step 1: agent-prompt (nodeId: 2)
Step 2: agent-prompt (nodeId: dndnode_0)
```

---

### 3. Debug Logging Added ✅

Đã thêm comprehensive logging vào:

**Backend (`src/gateway/server-cron.ts`):**

- Log khi job bắt đầu execution
- Log chain parsing (thành công/thất bại)
- Log từng step với: nodeId, actionType, prompt preview
- Log template rendering (`{{input}}` replacement)
- Log kết quả mỗi step (outputText, duration)
- Log chain completion với final output

**Frontend (`ui-next/app/workflows/use-workflows.ts`):**

- Log khi saveWorkflow được gọi
- Log trigger processing
- Log chain extraction
- Log cron job creation
- Log errors chi tiết

---

## 🛠️ Scripts Đã Tạo

### 1. `scripts/debug-workflow-chain.ts`

Phân tích workflow chain từ cron jobs file:

```bash
node scripts/debug-workflow-chain.ts
node scripts/debug-workflow-chain.ts <job-id>
node scripts/debug-workflow-chain.ts --file ~/.openclaw/cron/jobs.json
```

### 2. `scripts/trigger-workflow-manual.js`

Manually trigger workflow execution (bypass schedule):

```bash
node scripts/trigger-workflow-manual.js <job-id>
```

---

## 📋 Các Bước Test Tiếp Theo

### Option 1: Manual Trigger (Recommended)

```bash
# 1. Chạy debug script để xem chain
node scripts/debug-workflow-chain.ts

# 2. Manual trigger workflow
node scripts/trigger-workflow-manual.js

# 3. Theo dõi logs
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -i "workflow\|cron:"
```

### Option 2: Update Cron Expression

1. Mở Workflow Editor trong UI
2. Click vào node "Schedule (Cron)"
3. Đổi cron expression thành `*/5 * * * *` (mỗi 5 phút)
4. Save workflow
5. Đợi 5 phút và check logs

### Option 3: Gateway CLI

```bash
# List cron jobs
openclaw cron list

# Run specific job
openclaw cron run <job-id> --force

# Check status
openclaw cron status
```

---

## 🔧 Code Changes

### Files Modified:

1. **`src/gateway/server-cron.ts`** - Added extensive debug logging for workflow chain execution
2. **`ui-next/app/workflows/use-workflows.ts`** - Added debug logging + changed default cron to `*/5 * * * *`

### Files Added:

1. **`scripts/debug-workflow-chain.ts`** - Debug tool to parse and display workflow chains
2. **`scripts/trigger-workflow-manual.js`** - Manual trigger script

---

## 📊 Expected Log Output

Khi workflow chain execute thành công, bạn sẽ thấy logs như:

```
cron: starting job execution
cron: parsing workflow chain from description
cron: workflow chain parsed successfully
cron: starting sequential chain execution
cron: executing workflow chain step 1/2
cron: calling runCronIsolatedAgentTurn for step 1
cron: workflow chain step 1 completed successfully
cron: passing output to next step as input
cron: executing workflow chain step 2/2
cron: workflow chain execution completed
```

---

## ⚠️ Lưu Ý Quan Trọng

1. **Cron expression format:** `minute hour day month weekday`
   - `* * * * *` = mỗi phút
   - `*/5 * * * *` = mỗi 5 phút
   - `0 * * * *` = mỗi giờ đúng
   - `0 9 * * *` = 9:00 AM mỗi ngày
   - `0 9 * * 1-5` = 9:00 AM Thứ 2-6

2. **Workflow chain chỉ execute khi:**
   - Cron job enabled
   - Cron job đến giờ chạy (hoặc manual trigger)
   - Chain được parse thành công từ description

3. **Template `{{input}}`:**
   - Bước 1: `{{input}}` = message từ payload
   - Bước 2+: `{{input}}` = outputText từ bước trước

---

## 🎯 Kết Luận

**Vấn đề chính:** Cron expression `* * * * 5` chỉ chạy vào Thứ 6.

**Giải pháp:**

1. ✅ Đã thêm debug logging chi tiết
2. ✅ Đã tạo debug scripts
3. ✅ Đã fix default cron expression
4. ⏭️ Next: Manual trigger để test workflow execution

---

Generated: 2026-03-08 11:05 AM (Asia/Saigon)
