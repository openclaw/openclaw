---
summary: "แผน: SDKปลั๊กอินหนึ่งเดียวที่สะอาดตา+รันไทม์สำหรับคอนเน็กเตอร์ข้อความทั้งหมด"
read_when:
  - กำหนดหรือปรับโครงสร้างสถาปัตยกรรมปลั๊กอิน
  - ย้ายคอนเน็กเตอร์ช่องทางไปยังSDK/รันไทม์ของปลั๊กอิน
title: "การปรับโครงสร้างPlugin SDK"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:47Z
---

# แผนปรับโครงสร้างPlugin SDK+Runtime

เป้าหมาย: คอนเน็กเตอร์ข้อความทุกตัวเป็นปลั๊กอิน(แบบรวมมาด้วยหรือภายนอก)ที่ใช้APIเสถียรชุดเดียว
ปลั๊กอินต้องไม่ import จาก `src/**` โดยตรง การพึ่งพาทั้งหมดต้องผ่านSDKหรือรันไทม์

## ทำไมต้องทำตอนนี้

- คอนเน็กเตอร์ปัจจุบันผสมหลายรูปแบบ: import จากแกนหลักโดยตรง, สะพานเฉพาะdist, และตัวช่วยที่ทำขึ้นเอง
- ทำให้การอัปเกรดเปราะบางและขัดขวางการมีผิวหน้าให้ปลั๊กอินภายนอกที่สะอาด

## สถาปัตยกรรมเป้าหมาย(สองชั้น)

### 1) Plugin SDK(เวลาcompile, เสถียร, เผยแพร่ได้)

ขอบเขต: ชนิดข้อมูล ตัวช่วย และยูทิลิตีคอนฟิก ไม่มีสถานะรันไทม์ ไม่มีผลข้างเคียง

เนื้อหา(ตัวอย่าง):

- ชนิดข้อมูล: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- ตัวช่วยคอนฟิก: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- ตัวช่วยการจับคู่: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- ตัวช่วยการเริ่มต้นใช้งาน: `promptChannelAccessConfig`, `addWildcardAllowFrom`, ชนิดข้อมูลการเริ่มต้นใช้งาน.
- ตัวช่วยพารามิเตอร์เครื่องมือ: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- ตัวช่วยลิงก์เอกสาร: `formatDocsLink`.

การส่งมอบ:

- เผยแพร่เป็น `openclaw/plugin-sdk`(หรือส่งออกจากแกนหลักภายใต้ `openclaw/plugin-sdk`).
- ใช้semverพร้อมการรับประกันความเสถียรที่ชัดเจน

### 2) Plugin Runtime(ผิวหน้าการทำงาน, ฉีดเข้าไป)

ขอบเขต: ทุกอย่างที่แตะพฤติกรรมรันไทม์ของแกนหลัก
เข้าถึงผ่าน `OpenClawPluginApi.runtime` เพื่อให้ปลั๊กอินไม่ต้อง import `src/**`.

ผิวหน้าที่เสนอ(เล็กแต่ครบถ้วน):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

หมายเหตุ:

- รันไทม์เป็นหนทางเดียวในการเข้าถึงพฤติกรรมแกนหลัก
- SDKตั้งใจให้เล็กและเสถียร
- เมธอดรันไทม์แต่ละตัวแมปกับการทำงานเดิมในแกนหลัก(ไม่ทำซ้ำ)

## แผนย้ายระบบ(เป็นระยะ, ปลอดภัย)

### Phase 0: การเตรียมโครง

- แนะนำ `openclaw/plugin-sdk`.
- เพิ่ม `api.runtime` ลงใน `OpenClawPluginApi` พร้อมผิวหน้าด้านบน
- คงการimportเดิมไว้ระหว่างช่วงเปลี่ยนผ่าน(มีคำเตือนการเลิกใช้)

### Phase 1: ทำความสะอาดสะพานเชื่อม(ความเสี่ยงต่ำ)

- แทนที่ `core-bridge.ts` ต่อเอ็กซ์เทนชันด้วย `api.runtime`.
- ย้าย BlueBubbles, Zalo, Zalo Personal ก่อน(ใกล้เคียงอยู่แล้ว)
- ลบโค้ดสะพานที่ซ้ำซ้อน

### Phase 2: ปลั๊กอินที่importตรงเล็กน้อย

- ย้าย Matrix ไปยังSDK+รันไทม์
- ตรวจสอบการเริ่มต้นใช้งาน ไดเรกทอรี และตรรกะการกล่าวถึงกลุ่ม

### Phase 3: ปลั๊กอินที่importตรงหนัก

- ย้าย Microsoft Teams(ชุดตัวช่วยรันไทม์มากที่สุด)
- ทำให้แน่ใจว่าสมมติฐานการตอบกลับ/การพิมพ์ตรงกับพฤติกรรมปัจจุบัน

### Phase 4: ทำ iMessage ให้เป็นปลั๊กอิน

- ย้าย iMessage เข้า `extensions/imessage`.
- แทนที่การเรียกแกนหลักโดยตรงด้วย `api.runtime`.
- คงคีย์คอนฟิก พฤติกรรมCLI และเอกสารไว้เหมือนเดิม

### Phase 5: บังคับใช้

- เพิ่มกฎlint/การตรวจCI: ห้ามมีการimport `extensions/**` จาก `src/**`.
- เพิ่มการตรวจความเข้ากันได้ของเวอร์ชันปลั๊กอินSDK/รันไทม์(runtime+SDK semver)

## ความเข้ากันได้และการกำหนดเวอร์ชัน

- SDK: semver เผยแพร่และบันทึกการเปลี่ยนแปลง
- Runtime: กำหนดเวอร์ชันตามการปล่อยแกนหลัก เพิ่ม `api.runtime.version`.
- ปลั๊กอินระบุช่วงรันไทม์ที่ต้องการ(เช่น `openclawRuntime: ">=2026.2.0"`).

## กลยุทธ์การทดสอบ

- การทดสอบหน่วยระดับadapter(เรียกฟังก์ชันรันไทม์ด้วยการติดตั้งแกนหลักจริง)
- Golden tests ต่อปลั๊กอิน: ให้แน่ใจว่าไม่มีพฤติกรรมเพี้ยน(การกำหนดเส้นทาง การจับคู่ allowlist การควบคุมการกล่าวถึง)
- ตัวอย่างปลั๊กอินแบบend-to-endเพียงตัวเดียวใช้ในCI(ติดตั้ง+รัน+smoke)

## คำถามที่เปิดอยู่

- ควรโฮสต์ชนิดข้อมูลSDKที่ใด: แพ็กเกจแยกหรือส่งออกจากแกนหลัก?
- การกระจายชนิดข้อมูลรันไทม์: อยู่ในSDK(เฉพาะชนิดข้อมูล)หรือในแกนหลัก?
- จะเปิดเผยลิงก์เอกสารอย่างไรสำหรับปลั๊กอินที่รวมมาด้วยเทียบกับภายนอก?
- อนุญาตให้มีการimportแกนหลักโดยตรงแบบจำกัดสำหรับปลั๊กอินในรีโปช่วงเปลี่ยนผ่านหรือไม่?

## เกณฑ์ความสำเร็จ

- คอนเน็กเตอร์ช่องทางทั้งหมดเป็นปลั๊กอินที่ใช้SDK+รันไทม์
- ไม่มีการimport `extensions/**` จาก `src/**`.
- เทมเพลตคอนเน็กเตอร์ใหม่พึ่งพาเฉพาะSDK+รันไทม์
- ปลั๊กอินภายนอกสามารถพัฒนาและอัปเดตได้โดยไม่ต้องเข้าถึงซอร์สของแกนหลัก

เอกสารที่เกี่ยวข้อง: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
