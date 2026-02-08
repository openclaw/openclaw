---
summary: "ติดตั้ง OpenClaw และเริ่มแชตแรกของคุณได้ภายในไม่กี่นาที"
read_when:
  - ตั้งค่าใช้งานครั้งแรกจากศูนย์
  - คุณต้องการเส้นทางที่เร็วที่สุดไปสู่แชตที่ใช้งานได้
title: "เริ่มต้นใช้งาน"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:44Z
---

# เริ่มต้นใช้งาน

เป้าหมาย: จากศูนย์ไปสู่แชตแรกที่ใช้งานได้ด้วยการตั้งค่าขั้นต่ำ

<Info>
แชตที่เร็วที่สุด: เปิด Control UI (ไม่ต้องตั้งค่าช่องทาง) รัน `openclaw dashboard`
แล้วแชตในเบราว์เซอร์ หรือเปิด `http://127.0.0.1:18789/` บน
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">โฮสต์Gateway</Tooltip>.
เอกสาร: [Dashboard](/web/dashboard) และ [Control UI](/web/control-ui).
</Info>

## ข้อกำหนดก่อนเริ่มต้น

- Node 22 หรือใหม่กว่า

<Tip>
ตรวจสอบเวอร์ชัน Node ของคุณด้วย `node --version` หากไม่แน่ใจ
</Tip>

## ตั้งค่าอย่างรวดเร็ว(CLI)

<Steps>
  <Step title="ติดตั้ง OpenClaw (แนะนำ)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    วิธีติดตั้งอื่นๆและข้อกำหนด: [Install](/install).
    </Note>

  </Step>
  <Step title="รันวิซาร์ดเริ่มต้นใช้งาน">
    ```bash
    openclaw onboard --install-daemon
    ```

    วิซาร์ดจะตั้งค่าการยืนยันตัวตน การตั้งค่าGateway และช่องทางเสริม
    ดูรายละเอียดที่ [Onboarding Wizard](/start/wizard)

  </Step>
  <Step title="ตรวจสอบGateway">
    หากคุณติดตั้งบริการไว้แล้ว ควรกำลังทำงานอยู่:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="เปิด Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
หาก Control UI โหลดได้ แสดงว่าGatewayของคุณพร้อมใช้งานแล้ว
</Check>

## การตรวจสอบเพิ่มเติมและตัวเลือกเสริม

<AccordionGroup>
  <Accordion title="รันGatewayในโหมดเบื้องหน้า">
    มีประโยชน์สำหรับการทดสอบอย่างรวดเร็วหรือการแก้ไขปัญหา

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="ส่งข้อความทดสอบ">
    ต้องมีการตั้งค่าช่องทางแล้ว

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## เจาะลึกเพิ่มเติม

<Columns>
  <Card title="Onboarding Wizard (รายละเอียด)" href="/start/wizard">
    เอกสารอ้างอิงวิซาร์ดCLIแบบครบถ้วนและตัวเลือกขั้นสูง
  </Card>
  <Card title="การเริ่มต้นใช้งานแอปmacOS" href="/start/onboarding">
    โฟลว์การใช้งานครั้งแรกสำหรับแอปmacOS
  </Card>
</Columns>

## สิ่งที่คุณจะมี

- Gatewayที่กำลังทำงาน
- ตั้งค่าการยืนยันตัวตนแล้ว
- การเข้าถึง Control UI หรือมีช่องทางที่เชื่อมต่อแล้ว

## ขั้นตอนถัดไป

- ความปลอดภัยและการอนุมัติDM: [Pairing](/channels/pairing)
- เชื่อมต่อช่องทางเพิ่มเติม: [Channels](/channels)
- เวิร์กโฟลว์ขั้นสูงและการใช้งานจากซอร์ส: [Setup](/start/setup)
