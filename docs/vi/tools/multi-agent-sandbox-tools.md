---
summary: "Sandbox theo từng tác tử + hạn chế công cụ, thứ tự ưu tiên và ví dụ"
title: Sandbox & Công cụ đa tác tử
read_when: "Bạn muốn sandboxing theo từng tác tử hoặc chính sách cho phép/từ chối công cụ theo từng tác tử trong một gateway đa tác tử."
status: active
---

# Cấu hình Sandbox & Công cụ đa tác tử

## Tổng quan

Mỗi tác tử trong một thiết lập đa tác tử giờ đây có thể có riêng:

- **Cấu hình sandbox** (`agents.list[].sandbox` ghi đè `agents.defaults.sandbox`)
- **Hạn chế công cụ** (`tools.allow` / `tools.deny`, cùng với `agents.list[].tools`)

Điều này cho phép bạn chạy nhiều tác tử với các hồ sơ bảo mật khác nhau:

- Trợ lý cá nhân với quyền truy cập đầy đủ
- Tác tử gia đình/công việc với công cụ bị hạn chế
- Tác tử hướng ra công chúng trong sandbox

`setupCommand` thuộc về `sandbox.docker` (toàn cục hoặc theo tác tử) và chỉ chạy một lần
khi container được tạo.

Xác thực là theo từng tác tử: mỗi tác tử đọc từ kho xác thực `agentDir` riêng của nó tại:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Credentials are **not** shared between agents. Never reuse `agentDir` across agents.
If you want to share creds, copy `auth-profiles.json` into the other agent's `agentDir`.

11. Để biết hành vi sandbox khi chạy, xem [Sandboxing](/gateway/sandboxing).
12. Để gỡ lỗi “vì sao bị chặn?”, xem [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) và `openclaw sandbox explain`.

---

## Ví dụ cấu hình

### Ví dụ 1: Tác tử cá nhân + tác tử gia đình bị hạn chế

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**Kết quả:**

- Tác tử `main`: Chạy trên host, truy cập đầy đủ công cụ
- Tác tử `family`: Chạy trong Docker (mỗi tác tử một container), chỉ có công cụ `read`

---

### Ví dụ 2: Tác tử công việc với sandbox dùng chung

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### Ví dụ 2b: Hồ sơ coding toàn cục + tác tử chỉ nhắn tin

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**Kết quả:**

- Các tác tử mặc định có công cụ coding
- Tác tử `support` chỉ dành cho nhắn tin (+ công cụ Slack)

---

### Ví dụ 3: Các chế độ sandbox khác nhau theo từng tác tử

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## Thứ tự ưu tiên cấu hình

Khi tồn tại cả cấu hình toàn cục (`agents.defaults.*`) và cấu hình theo tác tử (`agents.list[].*`):

### Cấu hình Sandbox

Thiết lập theo tác tử sẽ ghi đè thiết lập toàn cục:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Ghi chú:**

- `agents.list[].sandbox.{docker,browser,prune}.*` ghi đè `agents.defaults.sandbox.{docker,browser,prune}.*` cho tác tử đó (bị bỏ qua khi phạm vi sandbox được giải quyết thành `"shared"`).

### Hạn chế công cụ

Thứ tự lọc là:

1. **Hồ sơ công cụ** (`tools.profile` hoặc `agents.list[].tools.profile`)
2. **Hồ sơ công cụ theo nhà cung cấp** (`tools.byProvider[provider].profile` hoặc `agents.list[].tools.byProvider[provider].profile`)
3. **Chính sách công cụ toàn cục** (`tools.allow` / `tools.deny`)
4. **Chính sách công cụ của nhà cung cấp** (`tools.byProvider[provider].allow/deny`)
5. **Chính sách công cụ theo tác tử** (`agents.list[].tools.allow/deny`)
6. **Chính sách nhà cung cấp theo tác tử** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Chính sách công cụ của sandbox** (`tools.sandbox.tools` hoặc `agents.list[].tools.sandbox.tools`)
8. **Chính sách công cụ của tác tử con** (`tools.subagents.tools`, nếu áp dụng)

13) Mỗi cấp có thể tiếp tục hạn chế công cụ, nhưng không thể cấp lại các công cụ đã bị từ chối ở các cấp trước.
14) Nếu `agents.list[].tools.sandbox.tools` được đặt, nó sẽ thay thế `tools.sandbox.tools` cho tác tử đó.
15) Nếu `agents.list[].tools.profile` được đặt, nó sẽ ghi đè `tools.profile` cho tác tử đó.
    Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.2`).

### Nhóm công cụ (viết tắt)

Chính sách công cụ (toàn cục, theo tác tử, sandbox) hỗ trợ các mục `group:*` mở rộng thành nhiều công cụ cụ thể:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: tất cả các công cụ OpenClaw tích hợp sẵn (không bao gồm plugin của nhà cung cấp)

### Chế độ Elevated

17. `tools.elevated` là đường cơ sở toàn cục (allowlist dựa trên người gửi). 18. `agents.list[].tools.elevated` có thể tiếp tục hạn chế elevated cho các tác tử cụ thể (cả hai đều phải cho phép).

Các mẫu giảm thiểu:

- Từ chối `exec` cho các tác tử không đáng tin cậy (`agents.list[].tools.deny: ["exec"]`)
- Tránh allowlist những người gửi định tuyến tới các tác tử bị hạn chế
- Vô hiệu hóa elevated toàn cục (`tools.elevated.enabled: false`) nếu bạn chỉ muốn thực thi trong sandbox
- Vô hiệu hóa elevated theo tác tử (`agents.list[].tools.elevated.enabled: false`) cho các hồ sơ nhạy cảm

---

## Di chuyển từ tác tử đơn

**Trước (tác tử đơn):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**Sau (đa tác tử với các hồ sơ khác nhau):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Các cấu hình `agent.*` cũ được di chuyển bởi `openclaw doctor`; về sau nên ưu tiên `agents.defaults` + `agents.list`.

---

## Ví dụ hạn chế công cụ

### Tác tử chỉ đọc

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Tác tử thực thi an toàn (không sửa đổi file)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Tác tử chỉ giao tiếp

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Lỗi thường gặp: "non-main"

19. `agents.defaults.sandbox.mode: "non-main"` dựa trên `session.mainKey` (mặc định `"main"`), không phải id của tác tử. 20. Các phiên nhóm/kênh luôn có khóa riêng, vì vậy chúng được coi là non-main và sẽ bị sandbox. 21. Nếu bạn muốn một tác tử không bao giờ bị sandbox, hãy đặt `agents.list[].sandbox.mode: "off"`.

---

## Kiểm thử

Sau khi cấu hình sandbox và công cụ đa tác tử:

1. **Kiểm tra phân giải tác tử:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Xác minh các container sandbox:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Kiểm tra hạn chế công cụ:**
   - Gửi một tin nhắn yêu cầu các công cụ bị hạn chế
   - Xác nhận tác tử không thể sử dụng các công cụ bị từ chối

4. **Theo dõi log:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Xử lý sự cố

### Tác tử không bị sandbox dù có `mode: "all"`

- Kiểm tra xem có `agents.defaults.sandbox.mode` toàn cục ghi đè hay không
- Cấu hình theo tác tử có ưu tiên cao hơn, vì vậy hãy đặt `agents.list[].sandbox.mode: "all"`

### Công cụ vẫn khả dụng dù có danh sách từ chối

- Kiểm tra thứ tự lọc công cụ: toàn cục → tác tử → sandbox → tác tử con
- Mỗi cấp chỉ có thể hạn chế thêm, không thể cấp lại
- Xác minh bằng log: `[tools] filtering tools for agent:${agentId}`

### Container không được cô lập theo từng tác tử

- Đặt `scope: "agent"` trong cấu hình sandbox theo tác tử
- Mặc định là `"session"` tạo một container cho mỗi phiên

---

## Xem thêm

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
