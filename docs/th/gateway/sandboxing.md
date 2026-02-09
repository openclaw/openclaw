---
summary: "วิธีการทำงานของsandboxingในOpenClaw: โหมด ขอบเขต การเข้าถึงเวิร์กสเปซ และอิมเมจ"
title: Sandboxing
read_when: "คุณต้องการคำอธิบายเฉพาะเกี่ยวกับsandboxingหรือจำเป็นต้องปรับแต่งagents.defaults.sandbox"
status: active
---

# Sandboxing

OpenClaw สามารถรัน **เครื่องมือภายในคอนเทนเนอร์ Docker** เพื่อลดขอบเขตผลกระทบ
This is **optional** and controlled by configuration (`agents.defaults.sandbox` or
`agents.list[].sandbox`). หากปิด sandbox เครื่องมือจะรันบนโฮสต์
OpenClawสามารถรัน**เครื่องมือภายในDocker containers**เพื่อลดขอบเขตความเสียหายที่อาจเกิดขึ้น
สิ่งนี้เป็น**ทางเลือก**และควบคุมด้วยการกำหนดค่า(`agents.defaults.sandbox`หรือ
`agents.list[].sandbox`) หากปิดsandboxing เครื่องมือจะรันบนโฮสต์
Gatewayยังคงอยู่บนโฮสต์ ส่วนการรันเครื่องมือจะเกิดขึ้นในsandboxที่แยกต่างหากเมื่อเปิดใช้งาน

นี่ไม่ใช่ขอบเขตความปลอดภัยที่สมบูรณ์แบบ แต่ช่วยจำกัดการเข้าถึงไฟล์ระบบ
และโปรเซสได้อย่างมีนัยสำคัญเมื่อโมเดลทำสิ่งที่ไม่เหมาะสม

## สิ่งที่ถูกsandbox

- การรันเครื่องมือ(`exec`, `read`, `write`, `edit`, `apply_patch`, `process` เป็นต้น)
- เบราว์เซอร์แบบsandboxที่เป็นทางเลือก(`agents.defaults.sandbox.browser`)
  - โดยค่าเริ่มต้น เบราว์เซอร์ในsandboxจะเริ่มอัตโนมัติ(เพื่อให้แน่ใจว่าCDPเข้าถึงได้)เมื่อเครื่องมือเบราว์เซอร์ต้องการใช้งาน
    กำหนดค่าผ่าน`agents.defaults.sandbox.browser.autoStart`และ`agents.defaults.sandbox.browser.autoStartTimeoutMs`
    กำหนดค่าผ่าน `agents.defaults.sandbox.browser.autoStart` และ `agents.defaults.sandbox.browser.autoStartTimeoutMs`
  - `agents.defaults.sandbox.browser.allowHostControl`ช่วยให้เซสชันในsandboxกำหนดเป้าหมายไปยังเบราว์เซอร์บนโฮสต์ได้โดยตรง
  - allowlistsแบบทางเลือกใช้ควบคุม`target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`

ไม่ถูกsandbox:

- ตัวโปรเซสของ Gateway เอง
- เครื่องมือใดๆที่อนุญาตให้รันบนโฮสต์อย่างชัดเจน(เช่น `tools.elevated`)
  - **การรันคำสั่งแบบยกระดับจะรันบนโฮสต์และข้ามsandboxing**
  - หากปิดsandboxing `tools.elevated`จะไม่เปลี่ยนแปลงการรัน(อยู่บนโฮสต์อยู่แล้ว) ดู [Elevated Mode](/tools/elevated) ดู [Elevated Mode](/tools/elevated)

## โหมด

`agents.defaults.sandbox.mode`ควบคุมว่าsandboxingถูกใช้**เมื่อใด**:

- `"off"`: ไม่มีsandboxing
- `"non-main"`: sandboxเฉพาะเซสชันที่**ไม่ใช่หลัก**(ค่าเริ่มต้นหากต้องการให้แชตปกติรันบนโฮสต์)
- `"all"`: ทุกเซสชันจะรันใน sandbox
  `"all"`: ทุกเซสชันรันในsandbox
  หมายเหตุ: `"non-main"`อิงจาก`session.mainKey`(ค่าเริ่มต้น`"main"`) ไม่ใช่agent id
  เซสชันแบบกลุ่ม/ช่องทางใช้คีย์ของตัวเอง ดังนั้นจะถูกนับว่าไม่ใช่หลักและจะถูกsandbox
  เซสชันกลุ่ม/แชนเนลใช้คีย์ของตนเอง ดังนั้นจึงนับเป็น non-main และจะถูกทำ sandbox

## ขอบเขต

`agents.defaults.sandbox.scope`ควบคุม**จำนวนcontainers**ที่ถูกสร้าง:

- `"session"`(ค่าเริ่มต้น): หนึ่งcontainerต่อหนึ่งเซสชัน
- `"agent"`: หนึ่งcontainerต่อหนึ่งเอเจนต์
- `"shared"`: หนึ่งcontainerที่แชร์โดยทุกเซสชันที่ถูกsandbox

## การเข้าถึงเวิร์กสเปซ

`agents.defaults.sandbox.workspaceAccess`ควบคุม**สิ่งที่sandboxสามารถมองเห็นได้**:

- `"none"`(ค่าเริ่มต้น): เครื่องมือจะเห็นเวิร์กสเปซของsandboxภายใต้`~/.openclaw/sandboxes`
- `"ro"`: เมานต์เวิร์กสเปซของเอเจนต์แบบอ่านอย่างเดียวที่`/agent`(ปิดการใช้งาน`write`/`edit`/`apply_patch`)
- `"rw"`: เมานต์เวิร์กสเปซของเอเจนต์แบบอ่าน/เขียนที่`/workspace`

สื่อขาเข้าจะถูกคัดลอกไปยังเวิร์กสเปซ sandbox ที่ใช้งานอยู่ (`media/inbound/*`)
หมายเหตุทักษะ: เครื่องมือ `read` ถูกผูกกับรากของ sandbox สื่อขาเข้าจะถูกคัดลอกไปยังเวิร์กสเปซsandboxที่ใช้งานอยู่(`media/inbound/*`)
หมายเหตุเกี่ยวกับSkills: เครื่องมือ`read`มีรากอยู่ในsandbox ด้วย`workspaceAccess: "none"`
OpenClawจะมิเรอร์skillsที่เข้าเกณฑ์ไปยังเวิร์กสเปซsandbox(`.../skills`)เพื่อให้อ่านได้
ด้วย`"rw"` skillsในเวิร์กสเปซสามารถอ่านได้จาก`/workspace/skills` ด้วย `"rw"` ทักษะของเวิร์กสเปซจะสามารถอ่านได้จาก
`/workspace/skills`

## Custom bind mounts

`agents.defaults.sandbox.docker.binds`เมานต์ไดเรกทอรีโฮสต์เพิ่มเติมเข้าไปในcontainer
รูปแบบ: `host:container:mode`(เช่น `"/home/user/source:/source:rw"`)
รูปแบบ: `host:container:mode` (เช่น `"/home/user/source:/source:rw"`).

bindแบบglobalและแบบต่อเอเจนต์จะถูก**รวมกัน**(ไม่ใช่แทนที่) ภายใต้`scope: "shared"` bindต่อเอเจนต์จะถูกละเว้น ภายใต้ `scope: "shared"` การ bind แบบต่อเอเจนต์จะถูกเพิกเฉย.

ตัวอย่าง(แหล่งอ่านอย่างเดียว + docker socket):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

หมายเหตุด้านความปลอดภัย:

- bindจะข้ามไฟล์ระบบของsandbox: มันเปิดเผยพาธของโฮสต์ตามโหมดที่คุณตั้ง(`:ro`หรือ`:rw`)
- การเมานต์ที่อ่อนไหว(เช่น `docker.sock`, secrets, SSH keys)ควรเป็น`:ro`เว้นแต่จำเป็นจริงๆ
- ใช้ร่วมกับ`workspaceAccess: "ro"`หากคุณต้องการเพียงสิทธิ์อ่านเวิร์กสเปซ โหมดของbindจะยังคงแยกอิสระ
- ดู [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) เพื่อดูว่าbindมีปฏิสัมพันธ์กับนโยบายเครื่องมือและการรันแบบยกระดับอย่างไร

## อิมเมจ + การตั้งค่า

อิมเมจเริ่มต้น: `openclaw-sandbox:bookworm-slim`

สร้างครั้งเดียว:

```bash
scripts/sandbox-setup.sh
```

หมายเหตุ: อิมเมจเริ่มต้น **ไม่ได้** รวม Node มาให้. หมายเหตุ: อิมเมจเริ่มต้น**ไม่มี**Node หากskillใดต้องการNode(หรือ
runtimeอื่นๆ) ให้สร้างอิมเมจแบบกำหนดเองหรือทำการติดตั้งผ่าน
`sandbox.docker.setupCommand`(ต้องมีการออกเครือข่าย + rootที่เขียนได้ +
ผู้ใช้root)

อิมเมจเบราว์เซอร์แบบsandbox:

```bash
scripts/sandbox-browser-setup.sh
```

โดยค่าเริ่มต้น containerของsandboxจะรันแบบ**ไม่มีเครือข่าย**
สามารถoverrideได้ด้วย`agents.defaults.sandbox.docker.network`
เขียนทับด้วย `agents.defaults.sandbox.docker.network`.

การติดตั้งDockerและGatewayแบบcontainerอยู่ที่นี่:
[Docker](/install/docker)

## setupCommand (การตั้งค่าcontainerครั้งเดียว)

`setupCommand`จะรัน**ครั้งเดียว**หลังจากสร้างcontainerของsandboxแล้ว(ไม่ใช่ทุกครั้งที่รัน)
มันถูกรันภายในcontainerผ่าน`sh -lc`
มันถูกรันภายในคอนเทนเนอร์ผ่าน `sh -lc`.

พาธ:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- ต่อเอเจนต์: `agents.list[].sandbox.docker.setupCommand`

ข้อผิดพลาดที่พบบ่อย:

- ค่าเริ่มต้น`docker.network`คือ`"none"`(ไม่มีการออกเครือข่าย) ดังนั้นการติดตั้งแพ็กเกจจะล้มเหลว
- `readOnlyRoot: true`ป้องกันการเขียน ให้ตั้ง`readOnlyRoot: false`หรือสร้างอิมเมจแบบกำหนดเอง
- `user`ต้องเป็นrootสำหรับการติดตั้งแพ็กเกจ(ละ`user`หรือกำหนด`user: "0:0"`)
- การรัน Sandbox **ไม่** สืบทอด `process.env` ของโฮสต์. การรันคำสั่งในsandboxจะ**ไม่**สืบทอด`process.env`จากโฮสต์ ใช้
  `agents.defaults.sandbox.docker.env`(หรืออิมเมจแบบกำหนดเอง)สำหรับคีย์APIของskill

## นโยบายเครื่องมือ + ช่องทางหลบหนี

นโยบายอนุญาต/ปฏิเสธของเครื่องมือยังคงถูกใช้ก่อนกฎของแซนด์บ็อกซ์. นโยบายอนุญาต/ปฏิเสธของเครื่องมือยังคงถูกใช้ก่อนกฎsandbox หากเครื่องมือถูกปฏิเสธ
ในระดับglobalหรือระดับเอเจนต์ sandboxingจะไม่ทำให้มันกลับมาใช้งานได้

`tools.elevated` คือช่องทางหลบหนีที่ระบุไว้อย่างชัดเจนซึ่งรัน `exec` บนโฮสต์.
`tools.elevated`เป็นช่องทางหลบหนีที่ชัดเจนซึ่งรัน`exec`บนโฮสต์
คำสั่ง`/exec`ใช้ได้เฉพาะผู้ส่งที่ได้รับอนุญาตและคงอยู่ต่อเซสชัน หากต้องการปิดใช้งาน
`exec`อย่างถาวร ให้ใช้นโยบายเครื่องมือแบบปฏิเสธ(ดู [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated))

การดีบัก:

- ใช้`openclaw sandbox explain`เพื่อตรวจสอบโหมดsandboxที่มีผลจริง นโยบายเครื่องมือ และคีย์คอนฟิกที่ใช้แก้ไข
- ดู [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) สำหรับโมเดลความคิดแบบ“ทำไมสิ่งนี้ถึงถูกบล็อก?”
  ควรล็อกให้รัดกุม

## การoverrideหลายเอเจนต์

แต่ละเอเจนต์สามารถoverride sandbox + เครื่องมือได้:
`agents.list[].sandbox`และ`agents.list[].tools`(รวมถึง`agents.list[].tools.sandbox.tools`สำหรับนโยบายเครื่องมือของsandbox)
ดู [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) สำหรับลำดับความสำคัญ
ดู [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) สำหรับลำดับความสำคัญ.

## ตัวอย่างการเปิดใช้งานขั้นต่ำ

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## เอกสารที่เกี่ยวข้อง

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
