# Workflow Session Debug Guide

## Vấn đề: Không thấy session sau khi RUN NOW cronjob

### Nguyên nhân

1. **Workflow sessions được cleanup khỏi bộ nhớ sau khi chạy xong** (để tiết kiệm RAM)
2. **Session data vẫn tồn tại trong:**
   - Log files (`~/.openclaw/logs/gateway.log`)
   - Cron run logs (`~/.openclaw/cron/runs/<job-id>.jsonl`)

### Cách xem workflow execution

#### 1. Xem Log Files (Recommended)

```bash
# Script tự động
./scripts/view-workflow-logs.sh <workflow-id>

# Xem manual
tail -f ~/.openclaw/logs/gateway.log | grep "workflow:"

# Tìm log của workflow cụ thể
grep "workflow:030f9921-7834-47d0-a9c1-8c16a0d08594" ~/.openclaw/logs/gateway.log
```

#### 2. Xem Cron Run Logs

```bash
# CLI command
openclaw cron runs --job-id <job-id>

# Xem file raw
cat ~/.openclaw/cron/runs/<job-id>.jsonl | jq '.'

# Xem run gần nhất
tail -n 1 ~/.openclaw/cron/runs/<job-id>.jsonl | jq '.'
```

#### 3. Debug Script

```bash
# Xem tất cả cron sessions
pnpm tsx scripts/debug-workflow-sessions.ts

# Filter theo job ID
pnpm tsx scripts/debug-workflow-sessions.ts --job-id <job-id>

# Xem agent khác
pnpm tsx scripts/debug-workflow-sessions.ts --agent rob
```

### Session Key Format

Workflow sessions có format đặc biệt:

```
agent:<agent-id>:workflow:<workflow-id>:<timestamp>:<step-id>:<node-id>
```

Ví dụ:

```
agent:main:workflow:030f9921-7834-47d0-a9c1-8c16a0d08594:1773719902534:1773719902545:2
agent:main:workflow:030f9921-7834-47d0-a9c1-8c16a0d08594:1773719902534:main
```

### Log Entries Quan Trọng

Khi workflow chạy, tìm các log sau:

```log
# Workflow bắt đầu
[workflow-cron:<job-id>:<timestamp>] Starting workflow execution: <name>. Steps: <count>

# Step execution
[workflow:<job-id>:<timestamp>] Executing step 1/3: <node-id>
[workflow:<job-id>:<timestamp>] Created isolated session for <node-id>
[workflow:tokens] Step <node-id>: input=1500, output=300, total=1800

# Step hoàn thành
[workflow:<job-id>:<timestamp>] Step <node-id> completed successfully

# Workflow hoàn thành
[workflow:<job-id>:<timestamp>] Workflow completed in 5432ms. Success: true
[workflow-cron:<job-id>:<timestamp>] Workflow completed successfully

# Session cleanup
[workflow:<job-id>:<timestamp>] Cleaned up 3 sessions
```

### Test Workflow chạy thành công

```bash
# 1. Chạy test script
./scripts/test-workflow-cron.sh

# 2. Run workflow manually
openclaw cron run <job-id>

# 3. Xem log real-time
tail -f ~/.openclaw/logs/gateway.log | grep -E "workflow:|cron:"

# 4. Check execution result
openclaw cron runs --job-id <job-id> --limit 1
```

### Troubleshooting

#### ❌ "No cron sessions found"

→ **Bình thường!** Sessions bị cleanup sau khi chạy xong. Xem log files thay thế.

#### ❌ "Channel is required"

Lỗi delivery - cần config channel trong workflow:

```json
{
  "delivery": {
    "mode": "announce",
    "channel": "telegram"
  }
}
```

#### ❌ Workflow không chạy

Kiểm tra:

```bash
# Xem cron job status
openclaw cron status

# Xem job có enabled không
openclaw cron list

# Chạy manual test
openclaw cron run <job-id> --mode force
```

### Session Persistence

Hiện tại sessions **không được lưu** vào file sau khi workflow hoàn thành vì:

1. Workflow sessions là **ephemeral** (tạm thời)
2. Chỉ dùng để track token usage trong lúc chạy
3. Cleanup để tránh memory leak

Nếu muốn lưu sessions (để debug), cần:

1. Sửa `workflow-executor.ts` - disable `cleanupSessions()`
2. Hoặc copy session data từ log trước khi cleanup

### Useful Commands

```bash
# Xem workflow config
cat ~/.openclaw/workflows/workflows.json | jq '.[] | {name, id, nodes: (.nodes | length)}'

# Xem cron job details
openclaw cron list --include-disabled | jq '.[] | select(.id == "<job-id>")'

# Watch logs real-time
tail -f ~/.openclaw/logs/gateway.log | grep -E "workflow:|STEP|COMPLETED|FAILED"

# Token usage summary
grep "Total tokens" ~/.openclaw/logs/gateway.log | tail -20
```

## Scripts đã tạo

1. `scripts/test-workflow-cron.sh` - Test workflow end-to-end
2. `scripts/debug-workflow-sessions.ts` - Debug sessions
3. `scripts/view-workflow-logs.sh` - Xem log workflow chi tiết

## Tham khảo

- Workflow Executor: `src/infra/cron/workflow-executor.ts`
- Cron Service Timer: `src/cron/service/timer.ts`
- Server Cron: `src/gateway/server-cron.ts`
- Cron Run Logs: `src/cron/run-log.ts`
