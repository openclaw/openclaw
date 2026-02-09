---
title: Sandbox CLI
summary: "จัดการคอนเทนเนอร์sandboxและตรวจสอบนโยบายsandboxที่มีผลจริง"
read_when: "เมื่อคุณกำลังจัดการคอนเทนเนอร์sandboxหรือแก้ไขปัญหาพฤติกรรมของsandbox/นโยบายเครื่องมือ"
status: active
---

# Sandbox CLI

จัดการคอนเทนเนอร์sandboxที่ใช้ Docker สำหรับการรันเอเจนต์แบบแยกส่วน

## ภาพรวม

2. OpenClaw สามารถรันเอเจนต์ในคอนเทนเนอร์ Docker ที่แยกจากกันเพื่อความปลอดภัย OpenClaw สามารถรันเอเจนต์ในคอนเทนเนอร์ Docker ที่แยกออกจากกันเพื่อความปลอดภัย คำสั่ง `sandbox` ช่วยให้คุณจัดการคอนเทนเนอร์เหล่านี้ได้ โดยเฉพาะหลังการอัปเดตหรือเปลี่ยนแปลงการกำหนดค่า

## คำสั่ง

### `openclaw sandbox explain`

ตรวจสอบโหมด/ขอบเขต/การเข้าถึงเวิร์กสเปซของsandboxที่มีผลจริง นโยบายเครื่องมือของsandbox และเกตที่มีสิทธิ์ยกระดับ (พร้อมพาธคีย์คอนฟิกสำหรับการแก้ไข)

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

แสดงรายการคอนเทนเนอร์sandboxทั้งหมดพร้อมสถานะและการกำหนดค่า

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**เอาต์พุตประกอบด้วย:**

- ชื่อคอนเทนเนอร์และสถานะ (running/stopped)
- อิมเมจ Docker และว่าตรงกับคอนฟิกหรือไม่
- อายุ (เวลาตั้งแต่สร้าง)
- เวลาว่าง (เวลาตั้งแต่ใช้งานครั้งล่าสุด)
- เซสชัน/เอเจนต์ที่เกี่ยวข้อง

### `openclaw sandbox recreate`

ลบคอนเทนเนอร์sandboxเพื่อบังคับให้สร้างใหม่ด้วยอิมเมจ/คอนฟิกที่อัปเดตแล้ว

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**ตัวเลือก:**

- `--all`: สร้างคอนเทนเนอร์sandboxทั้งหมดใหม่
- `--session <key>`: สร้างคอนเทนเนอร์ใหม่สำหรับเซสชันที่ระบุ
- `--agent <id>`: สร้างคอนเทนเนอร์ใหม่สำหรับเอเจนต์ที่ระบุ
- `--browser`: สร้างใหม่เฉพาะคอนเทนเนอร์เบราว์เซอร์
- `--force`: ข้ามการยืนยัน

**สำคัญ:** คอนเทนเนอร์จะถูกสร้างใหม่โดยอัตโนมัติเมื่อมีการใช้งานเอเจนต์ครั้งถัดไป

## กรณีการใช้งาน

### หลังจากอัปเดตอิมเมจ Docker

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### หลังจากเปลี่ยนการกำหนดค่าsandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### หลังจากเปลี่ยน setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### สำหรับเอเจนต์ที่ระบุเท่านั้น

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## ทำไมจึงจำเป็น?

**ปัญหา:** เมื่อคุณอัปเดตอิมเมจ Docker ของsandboxหรือการกำหนดค่า:

- คอนเทนเนอร์ที่มีอยู่จะยังคงทำงานด้วยการตั้งค่าเดิม
- คอนเทนเนอร์จะถูกลบออกก็ต่อเมื่อไม่มีการใช้งานเป็นเวลา 24 ชั่วโมง
- เอเจนต์ที่ใช้งานเป็นประจำจะคงคอนเทนเนอร์เดิมไว้ไม่มีกำหนด

**วิธีแก้ไข:** ใช้ `openclaw sandbox recreate` เพื่อบังคับลบคอนเทนเนอร์เก่า คอนเทนเนอร์จะถูกสร้างใหม่โดยอัตโนมัติด้วยการตั้งค่าปัจจุบันเมื่อจำเป็นต้องใช้งานครั้งถัดไป 3. พวกมันจะถูกสร้างใหม่โดยอัตโนมัติด้วยการตั้งค่าปัจจุบันเมื่อมีการใช้งานครั้งถัดไป

เคล็ดลับ: ควรใช้ `openclaw sandbox recreate` แทนการใช้ `docker rm` ด้วยตนเอง วิธีนี้ใช้รูปแบบการตั้งชื่อคอนเทนเนอร์ของGatewayและหลีกเลี่ยงความไม่ตรงกันเมื่อคีย์ขอบเขต/เซสชันเปลี่ยนแปลง 4. มันใช้
การตั้งชื่อคอนเทนเนอร์ของ Gateway และหลีกเลี่ยงความไม่ตรงกันเมื่อคีย์ scope/session เปลี่ยน

## การกำหนดค่า

การตั้งค่าsandboxอยู่ใน `~/.openclaw/openclaw.json` ภายใต้ `agents.defaults.sandbox` (การ override ต่อเอเจนต์อยู่ใน `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## ดูเพิ่มเติม

- [เอกสารSandbox](/gateway/sandboxing)
- [การกำหนดค่าเอเจนต์](/concepts/agent-workspace)
- [คำสั่งDoctor](/gateway/doctor) - ตรวจสอบการตั้งค่าsandbox
