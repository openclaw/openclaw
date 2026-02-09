---
summary: "การอนุมัติการรันคำสั่ง รายการอนุญาต และพรอมป์ต์การออกจากsandbox"
read_when:
  - การกำหนดค่าการอนุมัติการรันคำสั่งหรือรายการอนุญาต
  - การนำ UX การอนุมัติการรันคำสั่งไปใช้ในแอปmacOS
  - การทบทวนพรอมป์ต์การออกจากsandboxและผลกระทบ
title: "Exec Approvals"
---

# Exec approvals

Exec approvals คือ **การ์ดเรลของแอปคู่หู/โฮสต์โหนด** สำหรับการอนุญาตให้เอเจนต์ที่อยู่ในsandboxรันคำสั่งบนโฮสต์จริง (`gateway` หรือ `node`) เปรียบเหมือนอินเตอร์ล็อกด้านความปลอดภัย: คำสั่งจะถูกอนุญาตก็ต่อเมื่อ นโยบาย + รายการอนุญาต + (ไม่บังคับ) การอนุมัติจากผู้ใช้ เห็นพ้องกันทั้งหมด
Exec approvals เป็นการทำงาน **เพิ่มเติม** จากนโยบายเครื่องมือและการกั้นระดับสูง (เว้นแต่จะตั้ง elevated เป็น `full` ซึ่งจะข้ามการอนุมัติ)
นโยบายที่มีผลจริงคือค่าที่ **เข้มงวดกว่า** ระหว่าง `tools.exec.*` และค่าเริ่มต้นของการอนุมัติ; หากละเว้นฟิลด์ใดใน approvals จะใช้ค่า `tools.exec` Think of it like a safety interlock:
commands are allowed only when policy + allowlist + (optional) user approval all agree.
Exec approvals are **in addition** to tool policy and elevated gating (unless elevated is set to `full`, which skips approvals).
Effective policy is the **stricter** of `tools.exec.*` and approvals defaults; if an approvals field is omitted, the `tools.exec` value is used.

หาก UI ของแอปคู่หู **ไม่พร้อมใช้งาน** คำขอใดก็ตามที่ต้องการพรอมป์ต์จะถูกตัดสินด้วย **ask fallback** (ค่าเริ่มต้น: ปฏิเสธ)

## Where it applies

Exec approvals ถูกบังคับใช้ในเครื่องบนโฮสต์ที่รันคำสั่ง:

- **gateway host** → โปรเซส `openclaw` บนเครื่องเกตเวย์
- **node host** → ตัวรันโหนด (แอปคู่หูmacOSหรือโฮสต์โหนดแบบไม่มีหัว)

การแยกส่วนบน macOS:

- **node host service** ส่งต่อ `system.run` ไปยัง **แอปmacOS** ผ่าน IPC ภายในเครื่อง
- **แอปmacOS** บังคับใช้การอนุมัติ + รันคำสั่งในบริบทของ UI

## Settings and storage

การอนุมัติถูกเก็บในไฟล์ JSON ภายในเครื่องบนโฮสต์ที่รันคำสั่ง:

`~/.openclaw/exec-approvals.json`

โครงสร้างตัวอย่าง:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Policy knobs

### Security (`exec.security`)

- **deny**: บล็อกคำขอรันคำสั่งบนโฮสต์ทั้งหมด
- **allowlist**: อนุญาตเฉพาะคำสั่งที่อยู่ในรายการอนุญาต
- **full**: อนุญาตทั้งหมด (เทียบเท่า elevated)

### Ask (`exec.ask`)

- **off**: ไม่ถามเลย
- **on-miss**: ถามเฉพาะเมื่อไม่ตรงกับรายการอนุญาต
- **always**: ถามทุกคำสั่ง

### Ask fallback (`askFallback`)

หากต้องมีพรอมป์ต์แต่ไม่มี UI ให้เข้าถึง fallback จะตัดสิน:

- **deny**: บล็อก
- **allowlist**: อนุญาตเฉพาะเมื่อรายการอนุญาตตรง
- **full**: อนุญาต

## Allowlist (per agent)

Allowlists are **per agent**. If multiple agents exist, switch which agent you’re
editing in the macOS app. Patterns are **case-insensitive glob matches**.
Patterns should resolve to **binary paths** (basename-only entries are ignored).
Legacy `agents.default` entries are migrated to `agents.main` on load.

ตัวอย่าง:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

แต่ละรายการอนุญาตจะติดตาม:

- **id** UUID แบบคงที่สำหรับอัตลักษณ์ใน UI (ไม่บังคับ)
- **last used** เวลาใช้งานครั้งล่าสุด
- **last used command**
- **last resolved path**

## Auto-allow skill CLIs

เมื่อเปิด **Auto-allow skill CLIs** ไฟล์ปฏิบัติการที่อ้างอิงโดย Skills ที่รู้จักจะถือว่าอยู่ในรายการอนุญาตบนโหนด (โหนดmacOSหรือโฮสต์โหนดแบบไม่มีหัว)
ฟีเจอร์นี้ใช้ `skills.bins` ผ่าน Gateway RPC เพื่อดึงรายการไบนารีของสกิล ปิดใช้งานหากต้องการรายการอนุญาตแบบกำหนดเองที่เข้มงวด This uses
`skills.bins` over the Gateway RPC to fetch the skill bin list. Disable this if you want strict manual allowlists.

## Safe bins (stdin-only)

`tools.exec.safeBins` กำหนดรายการไบนารี **stdin-only** ขนาดเล็ก (เช่น `jq`)
ที่สามารถรันได้ในโหมด allowlist **โดยไม่ต้อง** มีรายการอนุญาตแบบเจาะจง
Safe bins จะปฏิเสธอาร์กิวเมนต์ไฟล์แบบตำแหน่งและโทเคนที่ดูเหมือนพาธ จึงทำงานได้เฉพาะกับสตรีมขาเข้า
การเชนเชลล์และการรีไดเรกชันจะไม่ถูกอนุญาตอัตโนมัติในโหมด allowlist Safe bins reject
positional file args and path-like tokens, so they can only operate on the incoming stream.
Shell chaining and redirections are not auto-allowed in allowlist mode.

Shell chaining (`&&`, `||`, `;`) is allowed when every top-level segment satisfies the allowlist
(including safe bins or skill auto-allow). Redirections remain unsupported in allowlist mode.
การเชนเชลล์ (`&&`, `||`, `;`) อนุญาตได้เมื่อทุกเซกเมนต์ระดับบนสุดผ่านรายการอนุญาต
(รวมถึง safe bins หรือการอนุญาตอัตโนมัติของสกิล) การรีไดเรกชันยังไม่รองรับในโหมด allowlist
การแทนที่คำสั่ง (`$()` / backticks) จะถูกปฏิเสธระหว่างการพาร์ส allowlist รวมถึงภายในเครื่องหมายคำพูดคู่
หากต้องการข้อความ `$()` แบบตัวอักษร ให้ใช้เครื่องหมายคำพูดเดี่ยว

Safe bins ค่าเริ่มต้น: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Control UI editing

ใช้การ์ด **Control UI → Nodes → Exec approvals** เพื่อแก้ไขค่าเริ่มต้น การ override ต่อเอเจนต์ และรายการอนุญาต
เลือกขอบเขต (Defaults หรือเอเจนต์) ปรับนโยบาย เพิ่ม/ลบรูปแบบรายการอนุญาต แล้วกด **Save**
UI จะแสดงเมทาดาทา **last used** ต่อรูปแบบ เพื่อช่วยจัดรายการให้เป็นระเบียบ Pick a scope (Defaults or an agent), tweak the policy,
add/remove allowlist patterns, then **Save**. The UI shows **last used** metadata
per pattern so you can keep the list tidy.

The target selector chooses **Gateway** (local approvals) or a **Node**. Nodes
must advertise `system.execApprovals.get/set` (macOS app or headless node host).
ตัวเลือกเป้าหมายจะเลือก **Gateway** (การอนุมัติในเครื่อง) หรือ **Node**
โหนดต้องโฆษณา `system.execApprovals.get/set` (แอปmacOSหรือโฮสต์โหนดแบบไม่มีหัว)
หากโหนดยังไม่โฆษณา exec approvals ให้แก้ไขไฟล์ `~/.openclaw/exec-approvals.json` ภายในเครื่องโดยตรง

CLI: `openclaw approvals` รองรับการแก้ไขทั้ง gateway หรือ node (ดู [Approvals CLI](/cli/approvals))

## Approval flow

When a prompt is required, the gateway broadcasts `exec.approval.requested` to operator clients.
เมื่อจำเป็นต้องมีพรอมป์ต์ เกตเวย์จะกระจาย `exec.approval.requested` ไปยังไคลเอนต์ของผู้ปฏิบัติการ
Control UI และแอปmacOS จะตัดสินผ่าน `exec.approval.resolve` จากนั้นเกตเวย์จะส่งต่อคำขอที่อนุมัติแล้วไปยังโฮสต์โหนด

When approvals are required, the exec tool returns immediately with an approval id. เมื่อจำเป็นต้องมีการอนุมัติ เครื่องมือ exec จะส่งคืนทันทีพร้อม id การอนุมัติ ใช้ id นี้เพื่อเชื่อมโยงกับอีเวนต์ระบบภายหลัง (`Exec finished` / `Exec denied`)
หากไม่มีการตัดสินใจก่อนหมดเวลา คำขอจะถูกถือว่า timeout ของการอนุมัติและแสดงเป็นเหตุผลการปฏิเสธ If no decision arrives before the
timeout, the request is treated as an approval timeout and surfaced as a denial reason.

กล่องยืนยันประกอบด้วย:

- คำสั่ง + อาร์กิวเมนต์
- cwd
- agent id
- พาธไฟล์ปฏิบัติการที่แก้ไขแล้ว
- เมทาดาทาโฮสต์ + นโยบาย

การกระทำ:

- **Allow once** → รันทันที
- **Always allow** → เพิ่มในรายการอนุญาต + รัน
- **Deny** → บล็อก

## Approval forwarding to chat channels

คุณสามารถส่งต่อพรอมป์ต์การอนุมัติการรันคำสั่งไปยังช่องทางแชตใดก็ได้ (รวมถึงช่องทางปลั๊กอิน) และอนุมัติด้วย `/approve`
กระบวนการนี้ใช้ไปป์ไลน์การส่งออกปกติเหมือนเดิม This uses the normal outbound delivery pipeline.

คอนฟิก:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

ตอบกลับในแชต:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC flow

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

หมายเหตุด้านความปลอดภัย:

- โหมด Unix socket `0600` โทเคนถูกเก็บไว้ที่ `exec-approvals.json`
- การตรวจสอบเพียร์ที่มี UID เดียวกัน
- กลไกท้าทาย/ตอบสนอง (nonce + โทเคน HMAC + แฮชคำขอ) + TTL สั้น

## System events

วงจรชีวิตของ exec จะถูกแสดงเป็นข้อความระบบ:

- `Exec running` (เฉพาะเมื่อคำสั่งใช้เวลานานเกินเกณฑ์แจ้งสถานะกำลังรัน)
- `Exec finished`
- `Exec denied`

These are posted to the agent’s session after the node reports the event.
Gateway-host exec approvals emit the same lifecycle events when the command finishes (and optionally when running longer than the threshold).
Approval-gated execs reuse the approval id as the `runId` in these messages for easy correlation.

## Implications

- **full** มีอำนาจสูง ควรเลือกใช้รายการอนุญาตเมื่อเป็นไปได้
- **ask** ช่วยให้คุณอยู่ในลูป ขณะเดียวกันยังอนุมัติได้รวดเร็ว
- รายการอนุญาตแบบต่อเอเจนต์ช่วยป้องกันไม่ให้การอนุมัติของเอเจนต์หนึ่งรั่วไปยังอีกเอเจนต์
- การอนุมัติใช้กับคำขอรันคำสั่งบนโฮสต์จาก **ผู้ส่งที่ได้รับอนุญาต** เท่านั้น ผู้ส่งที่ไม่ได้รับอนุญาตไม่สามารถออก `/exec` ได้ Unauthorized senders cannot issue `/exec`.
- `/exec security=full` is a session-level convenience for authorized operators and skips approvals by design.
  `/exec security=full` เป็นความสะดวกระดับเซสชันสำหรับผู้ปฏิบัติการที่ได้รับอนุญาตและข้ามการอนุมัติโดยออกแบบ
  หากต้องการบล็อกการรันคำสั่งบนโฮสต์อย่างเด็ดขาด ให้ตั้งค่า approvals security เป็น `deny` หรือปฏิเสธเครื่องมือ `exec` ผ่านนโยบายเครื่องมือ

Related:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
