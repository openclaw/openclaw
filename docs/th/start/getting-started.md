---
summary: "ติดตั้ง OpenClaw และเริ่มแชตแรกของคุณได้ภายในไม่กี่นาที"
read_when:
  - ตั้งค่าใช้งานครั้งแรกจากศูนย์
  - คุณต้องการเส้นทางที่เร็วที่สุดไปสู่แชตที่ใช้งานได้
title: "เริ่มต้นใช้งาน"
---

# เริ่มต้นใช้งาน

เป้าหมาย: จากศูนย์ไปสู่แชตแรกที่ใช้งานได้ด้วยการตั้งค่าขั้นต่ำ

<Info>
Fastest chat: open the Control UI (no channel setup needed). 
แชตที่เร็วที่สุด: เปิด Control UI (ไม่ต้องตั้งค่าช่องทาง) รัน `openclaw dashboard`
แล้วแชตในเบราว์เซอร์ หรือเปิด `http://127.0.0.1:18789/` บน

<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">โฮสต์Gateway</Tooltip>.
เอกสาร: [Dashboard](/web/dashboard) และ [Control UI](/web/control-ui).
</Info>

## Prereqs

- Node 22 หรือใหม่กว่า

<Tip>
ตรวจสอบเวอร์ชัน Node ของคุณด้วย `node --version` หากไม่แน่ใจ
</Tip>

## ตั้งค่าอย่างรวดเร็ว(CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
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

    ```
    <Note>
    วิธีติดตั้งอื่นๆและข้อกำหนด: [Install](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    วิซาร์ดจะตั้งค่าการยืนยันตัวตน การตั้งค่าGateway และช่องทางเสริม
    ดูรายละเอียดที่ [Onboarding Wizard](/start/wizard)
    ```

  </Step>
  <Step title="Check the Gateway">
    หากคุณติดตั้งบริการไว้แล้ว ควรกำลังทำงานอยู่:

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
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
  <Accordion title="Run the Gateway in the foreground">
    มีประโยชน์สำหรับการทดสอบอย่างรวดเร็วหรือการแก้ไขปัญหา

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    ต้องมีการตั้งค่าช่องทางแล้ว

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## เจาะลึกเพิ่มเติม

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    เอกสารอ้างอิงวิซาร์ดCLIแบบครบถ้วนและตัวเลือกขั้นสูง
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
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
