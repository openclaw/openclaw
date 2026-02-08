---
summary: "วิธีรันทดสอบในเครื่อง(vitest)และควรใช้โหมดบังคับ/โหมดครอบคลุมเมื่อใด"
read_when:
  - การรันหรือแก้ไขการทดสอบ
title: "การทดสอบ"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:43Z
---

# การทดสอบ

- ชุดเครื่องมือทดสอบครบถ้วน(สวีท,ไลฟ์,Docker): [Testing](/help/testing)

- `pnpm test:force`: ฆ่าโปรเซสGatewayที่ค้างอยู่ซึ่งครอบครองพอร์ตควบคุมเริ่มต้น จากนั้นรันชุดทดสอบ Vitest ทั้งหมดด้วยพอร์ตGatewayที่แยกออกมา เพื่อให้การทดสอบเซิร์ฟเวอร์ไม่ชนกับอินสแตนซ์ที่กำลังรันอยู่ ใช้กรณีที่การรันGatewayก่อนหน้าทิ้งพอร์ต18789ไว้
- `pnpm test:coverage`: รัน Vitest พร้อมความครอบคลุม V8 เกณฑ์รวมคือ70%สำหรับบรรทัด/แขนง/ฟังก์ชัน/สเตตเมนต์ การคำนวณความครอบคลุมจะยกเว้นจุดเริ่มต้นที่เน้นอินทิเกรชันหนัก(การเชื่อมสายCLI,บริดจ์gateway/telegram,เซิร์ฟเวอร์สแตติกเว็บแชต)เพื่อโฟกัสที่ลอจิกที่ทดสอบด้วยยูนิตได้
- `pnpm test:e2e`: รันการทดสอบสโมคแบบเอนด์ทูเอนด์ของGateway(การจับคู่WS/HTTP/โหนดหลายอินสแตนซ์)
- `pnpm test:live`: รันการทดสอบไลฟ์ของผู้ให้บริการ(minimax/zai)ต้องใช้คีย์APIและ`LIVE=1`(หรือ`*_LIVE_TEST=1`เฉพาะผู้ให้บริการ)เพื่อยกเลิกการข้าม

## การทดสอบความหน่วงของโมเดล(local keys)

สคริปต์: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

การใช้งาน:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- ตัวแปรสภาพแวดล้อม(ไม่บังคับ): `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- พรอมป์ต์เริ่มต้น: “ตอบด้วยคำเดียว: ok ห้ามมีเครื่องหมายวรรคตอนหรือข้อความเพิ่มเติม”

การรันล่าสุด(2025-12-31,20ครั้ง):

- minimax ค่ามัธยฐาน1279ms(ต่ำสุด1114,สูงสุด2431)
- opus ค่ามัธยฐาน2454ms(ต่ำสุด1224,สูงสุด3170)

## Onboarding E2E(Docker)

Dockerเป็นตัวเลือก ไม่จำเป็นหากไม่ทดสอบสโมคการเริ่มต้นแบบคอนเทนเนอร์

โฟลว์เริ่มต้นแบบcold-startเต็มรูปแบบในคอนเทนเนอร์Linuxที่สะอาด:

```bash
scripts/e2e/onboard-docker.sh
```

สคริปต์นี้จะขับวิซาร์ดแบบโต้ตอบผ่านpseudo-tty ตรวจสอบไฟล์คอนฟิก/เวิร์กสเปซ/เซสชัน จากนั้นเริ่มGatewayและรัน`openclaw health`.

## QR import smoke(Docker)

ตรวจสอบว่า`qrcode-terminal`โหลดได้ภายใต้Node22+ในDocker:

```bash
pnpm test:docker:qr
```
