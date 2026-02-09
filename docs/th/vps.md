---
summary: "ศูนย์รวมการโฮสต์VPSสำหรับOpenClaw(Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - คุณต้องการรันGatewayบนคลาวด์
  - คุณต้องการภาพรวมอย่างรวดเร็วของคู่มือVPS/การโฮสต์
title: "การโฮสต์VPS"
---

# การโฮสต์VPS

ฮับนี้เชื่อมไปยังคู่มือVPS/การโฮสต์ที่รองรับ และอธิบายภาพรวมระดับสูงของการดีพลอยบนคลาวด์

## เลือกผู้ให้บริการ

- **Railway** (คลิกครั้งเดียว + ตั้งค่าผ่านเบราว์เซอร์): [Railway](/install/railway)
- **Northflank** (คลิกครั้งเดียว + ตั้งค่าผ่านเบราว์เซอร์): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/เดือน (Always Free, ARM; ความจุ/การสมัครอาจจุกจิก)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + พร็อกซีHTTPS): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: ใช้งานได้ดีเช่นกัน วิดีโอไกด์:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547) วิดีโอแนะนำ:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## การตั้งค่าบนคลาวด์ทำงานอย่างไร

- **Gateway（เกตเวย์）รันอยู่บนVPS** และเป็นเจ้าของสถานะ + เวิร์กสเปซ
- คุณเชื่อมต่อจากแล็ปท็อป/โทรศัพท์ผ่าน **Control UI** หรือ **Tailscale/SSH**
- ถือว่าVPSเป็นแหล่งความจริงหลัก และ**สำรองข้อมูล**สถานะ + เวิร์กสเปซ
- ค่าเริ่มต้นที่ปลอดภัย: ให้Gatewayอยู่บน loopback และเข้าถึงผ่านอุโมงค์SSHหรือ Tailscale Serve
  หาก bind ไปที่ `lan`/`tailnet` ให้บังคับใช้ `gateway.auth.token` หรือ `gateway.auth.password`
  หากผูกกับ `lan`/`tailnet` ต้องกำหนด `gateway.auth.token` หรือ `gateway.auth.password`

การเข้าถึงระยะไกล: [Gateway remote](/gateway/remote)  
ฮับแพลตฟอร์ม: [Platforms](/platforms)

## การใช้โหนดกับVPS

คุณสามารถคงGatewayไว้บนคลาวด์ และจับคู่ **โหนด** บนอุปกรณ์ภายในเครื่องของคุณ
(Mac/iOS/Android/headless) โหนดให้ความสามารถด้านหน้าจอ/กล้อง/แคนวาสภายในเครื่อง และความสามารถ `system.run`
ในขณะที่Gatewayยังคงอยู่บนคลาวด์ Nodes ให้ความสามารถหน้าจอ/กล้อง/แคนวาสภายในเครื่อง และ `system.run` ในขณะที่ Gateway ยังคงอยู่บนคลาวด์

เอกสาร: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
