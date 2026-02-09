---
summary: "เช็กลิสต์การรีลีสแบบทีละขั้นตอนสำหรับ npm + แอปmacOS"
read_when:
  - การตัดรีลีส npm ใหม่
  - การตัดรีลีสแอปmacOS ใหม่
  - การตรวจสอบเมทาดาทาก่อนเผยแพร่
---

# เช็กลิสต์การรีลีส (npm + macOS)

ใช้ `pnpm` (Node 22+) จากรากของรีโป ใช้ `pnpm` (Node 22+) จากรากของรีโป ตรวจสอบให้แน่ใจว่า working tree สะอาดก่อนการแท็ก/เผยแพร่

## ทริกเกอร์ของผู้ปฏิบัติการ

เมื่อโอเปอเรเตอร์พูดว่า “release” ให้ทำ preflight นี้ทันที (ไม่ถามคำถามเพิ่มเติมเว้นแต่ติดขัด):

- อ่านเอกสารนี้และ `docs/platforms/mac/release.md`.
- โหลด env จาก `~/.profile` และยืนยันว่าได้ตั้งค่า `SPARKLE_PRIVATE_KEY_FILE` + ตัวแปร App Store Connect แล้ว (ไฟล์ SPARKLE_PRIVATE_KEY_FILE ควรอยู่ใน `~/.profile`).
- ใช้คีย์ Sparkle จาก `~/Library/CloudStorage/Dropbox/Backup/Sparkle` หากจำเป็น

1. **เวอร์ชันและเมทาดาทา**

- [ ] เพิ่มเวอร์ชัน `package.json` (เช่น `2026.1.29`).
- [ ] รัน `pnpm plugins:sync` เพื่อจัดแนวเวอร์ชันแพ็กเกจส่วนขยาย + changelog ให้ตรงกัน
- [ ] อัปเดตสตริง CLI/เวอร์ชัน: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) และ user agent ของ Baileys ใน [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] ยืนยันเมทาดาทาแพ็กเกจ (name, description, repository, keywords, license) และตรวจสอบว่า map ของ `bin` ชี้ไปที่ [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) สำหรับ `openclaw`.
- [ ] หากมีการเปลี่ยนแปลง dependencies ให้รัน `pnpm install` เพื่อให้ `pnpm-lock.yaml` เป็นปัจจุบัน

2. **บิลด์และอาร์ติแฟกต์**

- [ ] หากอินพุต A2UI เปลี่ยน ให้รัน `pnpm canvas:a2ui:bundle` และคอมมิต [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) ที่อัปเดตแล้ว (ถ้ามี)
- [ ] `pnpm run build` (สร้าง `dist/` ใหม่)
- [ ] ตรวจสอบว่าแพ็กเกจ npm `files` มีโฟลเดอร์ `dist/*` ที่จำเป็นทั้งหมด (โดยเฉพาะ `dist/node-host/**` และ `dist/acp/**` สำหรับโหนดแบบ headless + ACP CLI)
- [ ] ยืนยันว่า `dist/build-info.json` มีอยู่และมีแฮช `commit` ตามที่คาดไว้ (แบนเนอร์ CLI ใช้สิ่งนี้สำหรับการติดตั้งผ่าน npm)
- [ ] ทางเลือก: `npm pack --pack-destination /tmp` หลังการบิลด์; ตรวจสอบเนื้อหาใน tarball และเก็บไว้สำหรับ GitHub release (อย่าคอมมิต)

3. **Changelog และเอกสาร**

- [ ] อัปเดต `CHANGELOG.md` ด้วยไฮไลต์ที่ผู้ใช้เห็นได้ (สร้างไฟล์หากยังไม่มี); จัดลำดับรายการจากเวอร์ชันใหม่ไปเก่าอย่างเคร่งครัด
- [ ] ตรวจสอบให้แน่ใจว่าตัวอย่าง/แฟล็กใน README ตรงกับพฤติกรรม CLI ปัจจุบัน (โดยเฉพาะคำสั่งหรือออปชันใหม่)

4. **การตรวจสอบความถูกต้อง**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (หรือ `pnpm test:coverage` หากต้องการเอาต์พุต coverage)
- [ ] `pnpm release:check` (ตรวจสอบเนื้อหา npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (ทดสอบติดตั้ง Docker แบบ smoke test, fast path; ต้องทำก่อนรีลีส)
  - หากรีลีส npm ก่อนหน้าทันทีทราบว่าพัง ให้ตั้งค่า `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` หรือ `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` สำหรับขั้นตอน preinstall
- [ ] (ทางเลือก) Smoke ของตัวติดตั้งแบบเต็ม (เพิ่มการครอบคลุม non-root + CLI): `pnpm test:install:smoke`
- [ ] (ทางเลือก) Installer E2E (Docker, รัน `curl -fsSL https://openclaw.ai/install.sh | bash`, ทำ onboarding แล้วเรียกเครื่องมือจริง):
  - `pnpm test:install:e2e:openai` (ต้องใช้ `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (ต้องใช้ `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (ต้องใช้ทั้งสองคีย์; รันผู้ให้บริการทั้งคู่)
- [ ] (ทางเลือก) ตรวจเช็ค web gateway แบบสุ่ม หากการเปลี่ยนแปลงของคุณกระทบเส้นทางส่ง/รับ

5. **แอปmacOS (Sparkle)**

- [ ] บิลด์และเซ็นแอปmacOS จากนั้น zip เพื่อแจกจ่าย
- [ ] สร้าง Sparkle appcast (โน้ต HTML ผ่าน [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) และอัปเดต `appcast.xml`
- [ ] เก็บไฟล์ zip ของแอป (และ zip dSYM หากมี) ไว้เพื่อแนบกับ GitHub release
- [ ] ทำตาม [macOS release](/platforms/mac/release) สำหรับคำสั่งที่ถูกต้องและตัวแปร env ที่จำเป็น
  - `APP_BUILD` ต้องเป็นตัวเลขและเพิ่มขึ้นแบบ monotonic (ไม่มี `-beta`) เพื่อให้ Sparkle เปรียบเทียบเวอร์ชันได้ถูกต้อง
  - หากทำ notarize ให้ใช้โปรไฟล์ keychain `openclaw-notary` ที่สร้างจากตัวแปร env ของ App Store Connect API (ดู [macOS release](/platforms/mac/release))

6. **เผยแพร่ (npm)**

- [ ] ยืนยันว่า git status สะอาด; คอมมิตและพุชตามความจำเป็น
- [ ] `npm login` (ยืนยัน 2FA) หากจำเป็น
- [ ] `npm publish --access public` (ใช้ `--tag beta` สำหรับ pre-release)
- [ ] ตรวจสอบ registry: `npm view openclaw version`, `npm view openclaw dist-tags`, และ `npx -y openclaw@X.Y.Z --version` (หรือ `--help`)

### การแก้ไขปัญหา (บันทึกจากรีลีส 2.0.0-beta2)

- **npm pack/publish ค้างหรือสร้าง tarball ขนาดใหญ่มาก**: บันเดิลแอปmacOS ใน `dist/OpenClaw.app` (และไฟล์ zip ของรีลีส) ถูกดึงเข้าแพ็กเกจ แก้ไขโดย whitelist เนื้อหาที่เผยแพร่ผ่าน `package.json` `files` (รวม dist subdirs, docs, skills; ตัด app bundles ออก) ตรวจสอบด้วย `npm pack --dry-run` ว่าไม่มี `dist/OpenClaw.app` แสดงอยู่ แก้ไขโดยการ whitelist เนื้อหาที่เผยแพร่ผ่าน `package.json` `files` (รวมไดเรกทอรี dist, docs, skills; ไม่รวม app bundles) ยืนยันด้วย `npm pack --dry-run` ว่า `dist/OpenClaw.app` ไม่ถูกแสดงรายการ
- **npm auth web วนลูปสำหรับ dist-tags**: ใช้ legacy auth เพื่อให้มีการขอ OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **การยืนยัน `npx` ล้มเหลวด้วย `ECOMPROMISED: Lock compromised`**: ลองใหม่ด้วยแคชใหม่:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **ต้องชี้แท็กใหม่หลังแก้ไขช้า**: บังคับอัปเดตและพุชแท็ก จากนั้นตรวจสอบให้แน่ใจว่าแอสเซ็ตของ GitHub release ยังตรงกัน:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub release + appcast**

- [ ] แท็กและพุช: `git tag vX.Y.Z && git push origin vX.Y.Z` (หรือ `git push --tags`)
- [ ] สร้าง/รีเฟรช GitHub release สำหรับ `vX.Y.Z` โดยมี **ชื่อ `openclaw X.Y.Z`** (ไม่ใช่แค่แท็ก); เนื้อหาควรรวมส่วน changelog **ทั้งหมด** สำหรับเวอร์ชันนั้น (Highlights + Changes + Fixes) แบบฝังในตัว (ไม่มีลิงก์เปล่า) และ **ต้องไม่ซ้ำชื่อเรื่องภายในเนื้อหา**
- [ ] แนบอาร์ติแฟกต์: tarball `npm pack` (ทางเลือก), `OpenClaw-X.Y.Z.zip`, และ `OpenClaw-X.Y.Z.dSYM.zip` (ถ้ามีการสร้าง)
- [ ] คอมมิต `appcast.xml` ที่อัปเดตแล้วและพุช (Sparkle ดึงฟีดจาก main)
- [ ] จากไดเรกทอรีชั่วคราวที่สะอาด (ไม่มี `package.json`), รัน `npx -y openclaw@X.Y.Z send --help` เพื่อยืนยันว่าการติดตั้ง/จุดเข้า CLI ทำงานได้
- [ ] ประกาศ/แชร์บันทึกการออกเวอร์ชัน

## ขอบเขตการเผยแพร่ปลั๊กอิน (npm)

เราจะเผยแพร่เฉพาะ **ปลั๊กอิน npm ที่มีอยู่แล้ว** ภายใต้สโคป `@openclaw/*` เราจะเผยแพร่เฉพาะ **ปลั๊กอิน npm ที่มีอยู่แล้ว** ภายใต้สโคป `@openclaw/*` เท่านั้น ปลั๊กอินที่บันเดิลมาแต่ไม่ได้อยู่บน npm จะคงเป็น **disk-tree only** (ยังคงถูกส่งมอบใน `extensions/**`).

กระบวนการเพื่อหาไลสต์:

1. `npm search @openclaw --json` และบันทึกชื่อแพ็กเกจ
2. เปรียบเทียบกับชื่อใน `extensions/*/package.json`
3. เผยแพร่เฉพาะ **ส่วนตัดกัน** (ที่อยู่บน npm แล้ว)

รายการปลั๊กอิน npm ปัจจุบัน (อัปเดตตามต้องการ):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

โน้ตรีลีสต้องระบุ **ปลั๊กอินบันเดิลแบบเลือกใช้ใหม่** ที่ **ไม่เปิดใช้งานโดยค่าเริ่มต้น** ด้วย (ตัวอย่าง: `tlon`).
