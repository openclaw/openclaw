# Confirm Workflow Chạy Đúng Trên UI-Next

## 🎯 Các bước kiểm tra

### **Bước 1: Mở Workflow Editor**

1. Truy cập UI-Next: `http://localhost:3000/workflows` (hoặc URL của bạn)
2. Click vào workflow muốn test (ví dụ: "test wroflow")

### **Bước 2: Kiểm tra Workflow Configuration**

Trong workflow editor, verify:

#### ✅ **Trigger Node (Schedule Cron)**

- Node type: **Schedule (Cron)** ⏱️
- Cron expression: `* 8 * * *` (chạy mỗi phút lúc 8 giờ)
- Session Target: `reuse` hoặc `isolated`
- Context Mode: `minimal`

#### ✅ **Action Nodes**

Kiểm tra từng node AI Agent Prompt:

**Node 1 - Research:**

```
Label: AI Agent Prompt 🧠
Prompt: "Phân tích dự án tại users/tendoo/documents/wordlet-documents"
Delivery Mode: announce ✅
```

**Node 2 - Planning (CÓ {{input}} để nhận output từ node 1):**

```
Label: AI Agent Prompt 🧠
Prompt: "Dựa trên phân tích sau:

{{input}}

Hãy lên kế hoạch chi tiết để cải thiện UI/UX..."
Delivery Mode: announce ✅
```

#### ✅ **Edges (Connections)**

- Edge từ Trigger → Node 1 ✅
- Edge từ Node 1 → Node 2 ✅

### **Bước 3: Run Workflow Thủ Công**

#### **Cách 1: Run từ Workflow Editor**

1. Trong workflow editor, tìm nút **"Run"** hoặc **"Test Workflow"**
2. Click để execute ngay lập tức
3. Xem log output ở console hoặc log panel

#### **Cách 2: Run từ Cron Page**

1. Vào trang Cron: `http://localhost:3000/cron`
2. Tìm workflow job (tên: "Workflow: test wroflow")
3. Click nút **"Run Now"** ⚡
4. Xem kết quả execution

### **Bước 4: Monitor Execution Real-time**

#### **Xem Log Real-time**

Mở terminal và chạy:

```bash
# Xem log workflow
tail -f ~/.openclaw/logs/gateway.log | grep -E "workflow:|STEP|COMPLETED|FAILED"
```

**Log entries mong đợi:**

```log
✅ [gateway] Executing workflow: <job-id> with 2 steps
✅ [workflow-cron:<job-id>:<timestamp>] Starting workflow execution
✅ [workflow:<job-id>:<timestamp>] Starting workflow execution with 2 steps
✅ [workflow:<job-id>:<timestamp>] Executing step 1/2: <node-id>
✅ [workflow:<job-id>:<timestamp>] Created isolated session for <node-id>
✅ [workflow:tokens] Step <node-id>: input=1500, output=300, total=1800
✅ [workflow:<job-id>:<timestamp>] Step <node-id> completed successfully
✅ [workflow:<job-id>:<timestamp>] Executing step 2/2: <node-id>
✅ [workflow:<job-id>:<timestamp>] Workflow completed in 5432ms. Success: true
✅ [workflow-cron:<job-id>:<timestamp>] Workflow completed successfully
```

#### **Xem Cron Runs trên UI**

1. Vào trang Cron: `http://localhost:3000/cron`
2. Click vào job vừa chạy
3. Xem **"Recent Runs"** section
4. Kiểm tra:
   - Status: ✅ OK (màu xanh)
   - Duration: thời gian thực thi
   - Token usage: số tokens đã dùng

### **Bước 5: Verify Output Delivery**

Nếu workflow có delivery mode = "announce":

#### **Kiểm tra Telegram/Discord/Slack**

1. Mở channel đã config
2. Xem message từ bot
3. Verify nội dung đúng với output của workflow

#### **Xem Delivery Log**

```bash
# Xem delivery status
grep "delivered via announce" ~/.openclaw/logs/gateway.log | tail -10

# Hoặc xem cron run log
cat ~/.openclaw/cron/runs/<job-id>.jsonl | jq '.deliveryStatus'
```

### **Bước 6: Debug nếu có lỗi**

#### **❌ Lỗi: "Channel is required"**

**Triệu chứng:**

```json
{
  "status": "error",
  "error": "Channel is required (no configured channels detected)"
}
```

**Fix:**

1. Trong workflow editor, edit node
2. Set **Delivery Mode** = "announce"
3. Chọn **Channel** (Telegram/Discord/etc.)
4. Save workflow
5. Run lại

#### **❌ Lỗi: Node 2 không nhận output từ Node 1**

**Triệu chứng:**

- Node 2 chạy nhưng không có context từ Node 1

**Fix:**

1. Edit Node 2
2. Thêm `{{input}}` vào prompt:

   ```
   Dựa trên phân tích sau:

   {{input}}

   Hãy lên kế hoạch...
   ```

3. Save workflow
4. Run lại

#### **❌ Lỗi: Workflow không chạy**

**Check:**

```bash
# Xem cron job status
openclaw cron status

# Xem jobs list
openclaw cron list

# Xem chi tiết job
openclaw cron list | jq '.[] | select(.name == "Workflow: test wroflow")'
```

## 📊 UI-Next Workflow Page Features

### **Workflow List Page**

```
http://localhost:3000/workflows
```

- ✅ Danh sách workflows
- ✅ Create new workflow
- ✅ Edit workflow (ReactFlow editor)
- ✅ Delete workflow
- ⚠️ Run workflow (cần implement nút Run)

### **Cron Jobs Page**

```
http://localhost:3000/cron
```

- ✅ Danh sách cron jobs (bao gồm workflow jobs)
- ✅ Create new cron job
- ✅ Edit cron job
- ✅ Delete cron job
- ✅ **Run Now** button ⚡
- ✅ Toggle enable/disable
- ✅ Xem recent runs

### **Workflow → Cron Job Mapping**

Khi save workflow với Schedule trigger:

1. UI tạo **workflow chain** từ nodes + edges
2. Encode chain vào `description` với prefix `__wf_chain__:`
3. Tạo cron job với:
   ```json
   {
     "name": "Workflow: <workflow-name>",
     "description": "__wf_chain__:[{...steps...}]",
     "schedule": { "kind": "cron", "expr": "* 8 * * *" },
     "sessionTarget": "isolated",
     "payload": { "kind": "agentTurn", "message": "Ping from Workflow" }
   }
   ```

## 🔍 Test Script Tự Động

Tạo file `ui-next/app/workflows/test-workflow-ui.tsx`:

```tsx
// Test workflow execution from UI
import { useGateway } from "@/lib/use-gateway";

export function TestWorkflowButton({ workflowId }: { workflowId: string }) {
  const { request } = useGateway();

  const handleRun = async () => {
    try {
      // 1. Find cron job for this workflow
      const jobs = await request("cron.list", { includeDisabled: false });
      const workflowJob = jobs.jobs.find((j: any) => j.name === `Workflow: ${workflowId}`);

      if (!workflowJob) {
        alert("Cron job not found for this workflow");
        return;
      }

      // 2. Run the job
      await request("cron.run", { jobId: workflowJob.id });
      alert("Workflow started! Check logs for progress.");

      // 3. Optionally open logs
      window.open("/logs", "_blank");
    } catch (err) {
      alert(`Error: ${err}`);
    }
  };

  return <button onClick={handleRun}>🚀 Run Workflow</button>;
}
```

## ✅ Checklist Confirm Workflow Chạy Đúng

- [ ] Workflow editor hiển thị đúng nodes + edges
- [ ] Trigger node có cron expression hợp lệ
- [ ] Action nodes có prompt đúng (với `{{input}}` nếu cần)
- [ ] Delivery mode config đúng (announce/send-message)
- [ ] Click "Run Now" thành công
- [ ] Log hiển thị: "Starting workflow execution"
- [ ] Log hiển thị: "Executing step X/Y" cho từng node
- [ ] Log hiển thị: "Workflow completed successfully"
- [ ] Token usage được log: "Total tokens: XXXX"
- [ ] Output được deliver đến channel (nếu có)
- [ ] Cron runs page hiển thị status = OK

## 🎨 UI Screenshots mong đợi

### **Workflow Editor**

```
┌─────────────────────────────────────────┐
│  test wroflow                    [Save] │
├─────────────────────────────────────────┤
│                                         │
│  ⏱️ Schedule (Cron)                     │
│     └─ edge                             │
│        └─ 🧠 AI Agent Prompt (Node 1)   │
│           └─ edge                       │
│              └─ 🧠 AI Agent Prompt (Node 2)
│                                         │
│  [+ Add Node]                           │
└─────────────────────────────────────────┘
```

### **Cron Runs**

```
┌─────────────────────────────────────────┐
│ Recent Runs                             │
├─────────────────────────────────────────┤
│ ✅ OK  |  81.2s  |  24720 tokens       │
│ ❌ Error |  5.4s  |  Delivery failed   │
│ ✅ OK  |  12.1s  |  8395 tokens        │
└─────────────────────────────────────────┘
```

## 📖 Tham khảo

- Workflow Editor: `ui-next/app/workflows/workflow-editor.tsx`
- Use Workflows Hook: `ui-next/app/workflows/use-workflows.ts`
- Cron Page: `ui-next/app/cron/page.tsx`
- Backend Executor: `src/infra/cron/workflow-executor.ts`
