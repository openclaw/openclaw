---
summary: "sandboxต่อเอเจนต์+ข้อจำกัดเครื่องมือ ลำดับความสำคัญ และตัวอย่าง"
title: Sandboxและเครื่องมือแบบหลายเอเจนต์
read_when: "คุณต้องการsandboxingต่อเอเจนต์หรือกำหนดนโยบายอนุญาต/ปฏิเสธเครื่องมือต่อเอเจนต์ในGatewayแบบหลายเอเจนต์"
status: active
---

# การกำหนดค่าSandboxและเครื่องมือแบบหลายเอเจนต์

## ภาพรวม

เอเจนต์แต่ละตัวในการตั้งค่าแบบหลายเอเจนต์สามารถมีของตัวเองได้แล้ว:

- **การกำหนดค่าSandbox** (`agents.list[].sandbox` มีลำดับเหนือ `agents.defaults.sandbox`)
- **ข้อจำกัดเครื่องมือ** (`tools.allow` / `tools.deny` รวมถึง `agents.list[].tools`)

สิ่งนี้ช่วยให้คุณรันเอเจนต์หลายตัวด้วยโปรไฟล์ความปลอดภัยที่แตกต่างกันได้:

- ผู้ช่วยส่วนตัวที่เข้าถึงได้เต็มรูปแบบ
- เอเจนต์ครอบครัว/งานที่จำกัดเครื่องมือ
- เอเจนต์ที่เปิดสาธารณะซึ่งทำงานในsandbox

`setupCommand` อยู่ภายใต้ `sandbox.docker` (ส่วนกลางหรือต่อเอเจนต์) และรันเพียงครั้งเดียว
เมื่อคอนเทนเนอร์ถูกสร้างขึ้น

การยืนยันตัวตนเป็นแบบต่อเอเจนต์: เอเจนต์แต่ละตัวอ่านจากคลังยืนยันตัวตน `agentDir` ของตัวเองที่:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Credentials are **not** shared between agents. Never reuse `agentDir` across agents.
ข้อมูลรับรอง **ไม่** ถูกแชร์ระหว่างเอเจนต์ ห้ามนำ `agentDir` ไปใช้ซ้ำข้ามเอเจนต์
หากต้องการแชร์ข้อมูลรับรอง ให้คัดลอก `auth-profiles.json` ไปยัง `agentDir` ของเอเจนต์อื่น

สำหรับพฤติกรรมของsandboxขณะรัน ดูที่ [Sandboxing](/gateway/sandboxing)
สำหรับการดีบักว่า “ทำไมจึงถูกบล็อก?”
ดู [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) และ `openclaw sandbox explain`

---

## ตัวอย่างการกำหนดค่า

### ตัวอย่างที่1: เอเจนต์ส่วนตัว+เอเจนต์ครอบครัวที่จำกัด

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

**ผลลัพธ์:**

- เอเจนต์ `main`: รันบนโฮสต์ เข้าถึงเครื่องมือได้เต็มรูปแบบ
- เอเจนต์ `family`: รันในDocker (หนึ่งคอนเทนเนอร์ต่อเอเจนต์) ใช้ได้เฉพาะเครื่องมือ `read`

---

### ตัวอย่างที่2: เอเจนต์งานที่ใช้Sandboxร่วมกัน

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

### ตัวอย่างที่2b: โปรไฟล์โค้ดดิ้งส่วนกลาง+เอเจนต์เฉพาะการส่งข้อความ

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

**ผลลัพธ์:**

- เอเจนต์ค่าเริ่มต้นได้รับเครื่องมือโค้ดดิ้ง
- เอเจนต์ `support` เป็นแบบส่งข้อความเท่านั้น (+เครื่องมือ Slack)

---

### ตัวอย่างที่3: โหมดSandboxต่างกันต่อเอเจนต์

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

## ลำดับความสำคัญของการกำหนดค่า

เมื่อมีทั้งการกำหนดค่าส่วนกลาง (`agents.defaults.*`) และแบบเฉพาะเอเจนต์ (`agents.list[].*`):

### การกำหนดค่าSandbox

การตั้งค่าเฉพาะเอเจนต์จะมีลำดับเหนือส่วนกลาง:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**หมายเหตุ:**

- `agents.list[].sandbox.{docker,browser,prune}.*` มีลำดับเหนือ `agents.defaults.sandbox.{docker,browser,prune}.*` สำหรับเอเจนต์นั้น (จะถูกละเว้นเมื่อขอบเขตsandboxแก้ค่าเป็น `"shared"`)

### ข้อจำกัดเครื่องมือ

ลำดับการกรองคือ:

1. **โปรไฟล์เครื่องมือ** (`tools.profile` หรือ `agents.list[].tools.profile`)
2. **โปรไฟล์เครื่องมือของผู้ให้บริการ** (`tools.byProvider[provider].profile` หรือ `agents.list[].tools.byProvider[provider].profile`)
3. **นโยบายเครื่องมือส่วนกลาง** (`tools.allow` / `tools.deny`)
4. **นโยบายเครื่องมือของผู้ให้บริการ** (`tools.byProvider[provider].allow/deny`)
5. **นโยบายเครื่องมือเฉพาะเอเจนต์** (`agents.list[].tools.allow/deny`)
6. **นโยบายผู้ให้บริการของเอเจนต์** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **นโยบายเครื่องมือของsandbox** (`tools.sandbox.tools` หรือ `agents.list[].tools.sandbox.tools`)
8. **นโยบายเครื่องมือของซับเอเจนต์** (`tools.subagents.tools` หากมี)

Each level can further restrict tools, but cannot grant back denied tools from earlier levels.
If `agents.list[].tools.sandbox.tools` is set, it replaces `tools.sandbox.tools` for that agent.
If `agents.list[].tools.profile` is set, it overrides `tools.profile` for that agent.
Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.2`).

### กลุ่มเครื่องมือ(ชอร์ตแฮนด์)

นโยบายเครื่องมือ (ส่วนกลาง เอเจนต์ sandbox) รองรับรายการ `group:*` ที่ขยายเป็นเครื่องมือจริงหลายตัว:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: เครื่องมือ OpenClaw ที่ติดมากับระบบทั้งหมด (ไม่รวมปลั๊กอินผู้ให้บริการ)

### โหมดElevated

`tools.elevated` is the global baseline (sender-based allowlist). `tools.elevated` คือฐานส่วนกลาง (allowlistตามผู้ส่ง) โดย `agents.list[].tools.elevated` สามารถจำกัดเพิ่มเติมสำหรับเอเจนต์เฉพาะได้ (ทั้งสองต้องอนุญาต)

รูปแบบการลดความเสี่ยง:

- ปฏิเสธ `exec` สำหรับเอเจนต์ที่ไม่น่าเชื่อถือ (`agents.list[].tools.deny: ["exec"]`)
- หลีกเลี่ยงการใส่ผู้ส่งในallowlistที่ส่งต่อไปยังเอเจนต์ที่ถูกจำกัด
- ปิดElevatedทั่วทั้งระบบ (`tools.elevated.enabled: false`) หากต้องการเฉพาะการรันในsandbox
- ปิดElevatedต่อเอเจนต์ (`agents.list[].tools.elevated.enabled: false`) สำหรับโปรไฟล์ที่อ่อนไหว

---

## การย้ายจากเอเจนต์เดี่ยว

**ก่อน (เอเจนต์เดี่ยว):**

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

**หลัง (หลายเอเจนต์พร้อมโปรไฟล์ต่างกัน):**

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

คอนฟิก `agent.*` แบบเดิมจะถูกย้ายโดย `openclaw doctor`; แนะนำให้ใช้ `agents.defaults` + `agents.list` ต่อไป

---

## ตัวอย่างข้อจำกัดเครื่องมือ

### เอเจนต์อ่านอย่างเดียว

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### เอเจนต์รันอย่างปลอดภัย(ไม่แก้ไขไฟล์)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### เอเจนต์เฉพาะการสื่อสาร

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## ข้อผิดพลาดที่พบบ่อย: "non-main"

`agents.defaults.sandbox.mode: "non-main"` อ้างอิงจาก `session.mainKey` (ค่าเริ่มต้น `"main"`)
ไม่ใช่รหัสเอเจนต์ เซสชันกลุ่ม/ช่องทางจะได้คีย์ของตัวเองเสมอ
จึงถูกมองว่าเป็น non-main และจะถูกsandbox หากต้องการให้เอเจนต์ไม่เข้าsandboxเลย
ให้ตั้งค่า `agents.list[].sandbox.mode: "off"` เซสชันแบบกลุ่ม/ช่องจะได้รับคีย์ของตัวเองเสมอ ดังนั้นจึงถูกจัดว่าไม่ใช่ main และจะถูก sandbox หากคุณต้องการให้อเจนต์ไม่ถูก sandbox เลย ให้ตั้งค่า `agents.list[].sandbox.mode: "off"`

---

## การทดสอบ

หลังจากกำหนดค่าsandboxและเครื่องมือแบบหลายเอเจนต์แล้ว:

1. **ตรวจสอบการแก้ชื่อเอเจนต์:**

   ```exec
   openclaw agents list --bindings
   ```

2. **ตรวจสอบคอนเทนเนอร์sandbox:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **ทดสอบข้อจำกัดเครื่องมือ:**
   - ส่งข้อความที่ต้องใช้เครื่องมือที่ถูกจำกัด
   - ตรวจสอบว่าเอเจนต์ไม่สามารถใช้เครื่องมือที่ถูกปฏิเสธได้

4. **ติดตามบันทึกล็อก:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## การแก้ไขปัญหา

### เอเจนต์ไม่ถูกsandboxแม้ตั้งค่า `mode: "all"`

- ตรวจสอบว่ามี `agents.defaults.sandbox.mode` ส่วนกลางที่มีลำดับเหนือกว่าหรือไม่
- คอนฟิกเฉพาะเอเจนต์มีลำดับสูงกว่า ดังนั้นให้ตั้งค่า `agents.list[].sandbox.mode: "all"`

### เครื่องมือยังใช้งานได้แม้อยู่ในรายการปฏิเสธ

- ตรวจสอบลำดับการกรองเครื่องมือ: ส่วนกลาง → เอเจนต์ → sandbox → ซับเอเจนต์
- แต่ละระดับทำได้เพียงจำกัดเพิ่มเติม ไม่สามารถคืนสิทธิ์
- ตรวจสอบด้วยล็อก: `[tools] filtering tools for agent:${agentId}`

### คอนเทนเนอร์ไม่ถูกแยกต่อเอเจนต์

- ตั้งค่า `scope: "agent"` ในการกำหนดค่าsandboxเฉพาะเอเจนต์
- ค่าเริ่มต้นคือ `"session"` ซึ่งจะสร้างหนึ่งคอนเทนเนอร์ต่อเซสชัน

---

## ดูเพิ่มเติม

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
