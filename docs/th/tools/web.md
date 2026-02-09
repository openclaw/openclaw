---
summary: "เครื่องมือค้นหาเว็บและดึงข้อมูล (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - คุณต้องการเปิดใช้งาน web_search หรือ web_fetch
  - คุณต้องการตั้งค่าคีย์ Brave Search API
  - คุณต้องการใช้ Perplexity Sonar สำหรับการค้นหาเว็บ
title: "เครื่องมือเว็บ"
---

# เครื่องมือเว็บ

OpenClaw มาพร้อมเครื่องมือเว็บแบบเบาสองรายการ:

- `web_search` — ค้นหาเว็บผ่าน Brave Search API (ค่าเริ่มต้น) หรือ Perplexity Sonar (โดยตรงหรือผ่าน OpenRouter)
- `web_fetch` — ดึงข้อมูล HTTP + การสกัดเนื้อหาให้อ่านง่าย (HTML → markdown/text)

These are **not** browser automation. สิ่งเหล่านี้ **ไม่ใช่** การทำงานอัตโนมัติของเบราว์เซอร์ สำหรับไซต์ที่ใช้ JS หนักหรือจำเป็นต้องล็อกอิน ให้ใช้
[เครื่องมือ Browser](/tools/browser)

## ทำงานอย่างไร

- `web_search` เรียกผู้ให้บริการที่คุณกำหนดค่าไว้และส่งคืนผลลัพธ์
  - **Brave** (ค่าเริ่มต้น): ส่งคืนผลลัพธ์แบบมีโครงสร้าง (ชื่อเรื่อง, URL, ข้อความสรุป)
  - **Perplexity**: ส่งคืนคำตอบที่สังเคราะห์โดย AI พร้อมการอ้างอิงจากการค้นหาเว็บแบบเรียลไทม์
- ผลลัพธ์จะถูกแคชตามคำค้นเป็นเวลา 15 นาที (ปรับค่าได้)
- `web_fetch` ทำ HTTP GET แบบธรรมดาและสกัดเนื้อหาที่อ่านง่าย
  (HTML → markdown/text) โดย **ไม่** รัน JavaScript It does **not** execute JavaScript.
- `web_fetch` เปิดใช้งานเป็นค่าเริ่มต้น (เว้นแต่จะปิดใช้งานอย่างชัดเจน)

## การเลือกผู้ให้บริการค้นหา

| ผู้ให้บริการ                               | ข้อดี                                  | Cons                                        | คีย์API                                        |
| ------------------------------------------ | -------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| **Brave** (ค่าเริ่มต้น) | รวดเร็ว ผลลัพธ์มีโครงสร้าง มีฟรีเทียร์ | ผลการค้นหาแบบดั้งเดิม                       | `BRAVE_API_KEY`                                |
| **Perplexity**                             | คำตอบจาก AI มีการอ้างอิง แบบเรียลไทม์  | ต้องมีการเข้าถึง Perplexity หรือ OpenRouter | `OPENROUTER_API_KEY` หรือ `PERPLEXITY_API_KEY` |

ดูรายละเอียดเฉพาะผู้ให้บริการที่ [Brave Search setup](/brave-search) และ [Perplexity Sonar](/perplexity)

ตั้งค่าผู้ให้บริการในคอนฟิก:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

ตัวอย่าง: สลับไปใช้ Perplexity Sonar (direct API):

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## การขอคีย์ Brave API

1. สร้างบัญชี Brave Search API ที่ [https://brave.com/search/api/](https://brave.com/search/api/)
2. ในแดชบอร์ด เลือกแพ็กเกจ **Data for Search** (ไม่ใช่ “Data for AI”) และสร้างคีย์API
3. รัน `openclaw configure --section web` เพื่อบันทึกคีย์ไว้ในคอนฟิก (แนะนำ) หรือกำหนด `BRAVE_API_KEY` ในสภาพแวดล้อมของคุณ

Brave มีทั้งฟรีเทียร์และแผนชำระเงิน ตรวจสอบข้อจำกัดและราคา最新ได้ที่พอร์ทัล Brave API

### ตำแหน่งที่ตั้งค่าคีย์ (แนะนำ)

**Recommended:** run `openclaw configure --section web`. **แนะนำ:** รัน `openclaw configure --section web` ระบบจะบันทึกคีย์ไว้ใน
`~/.openclaw/openclaw.json` ภายใต้ `tools.web.search.apiKey`

**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process
environment. **ทางเลือกผ่านสภาพแวดล้อม:** ตั้งค่า `BRAVE_API_KEY` ในสภาพแวดล้อมของกระบวนการ Gateway
สำหรับการติดตั้งแบบ gateway ให้ใส่ไว้ใน `~/.openclaw/.env` (หรือสภาพแวดล้อมของบริการของคุณ)
ดู [Env vars](/help/faq#how-does-openclaw-load-environment-variables) See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## การใช้ Perplexity (โดยตรงหรือผ่าน OpenRouter)

โมเดล Perplexity Sonar มีความสามารถค้นหาเว็บในตัวและส่งคืนคำตอบที่สังเคราะห์โดย AI พร้อมการอ้างอิง คุณสามารถใช้ผ่าน OpenRouter (ไม่ต้องใช้บัตรเครดิต รองรับคริปโต/พรีเพด) You can use them via OpenRouter (no credit card required - supports
crypto/prepaid).

### การขอคีย์ OpenRouter API

1. สร้างบัญชีที่ [https://openrouter.ai/](https://openrouter.ai/)
2. เติมเครดิต (รองรับคริปโต พรีเพด หรือบัตรเครดิต)
3. สร้างคีย์API ในการตั้งค่าบัญชีของคุณ

### การตั้งค่าการค้นหา Perplexity

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**ทางเลือกผ่านสภาพแวดล้อม:** ตั้งค่า `OPENROUTER_API_KEY` หรือ `PERPLEXITY_API_KEY` ในสภาพแวดล้อมของ Gateway
สำหรับการติดตั้งแบบ gateway ให้ใส่ไว้ใน `~/.openclaw/.env` For a gateway install, put it in `~/.openclaw/.env`.

หากไม่ได้ตั้งค่า base URL, OpenClaw จะเลือกค่าเริ่มต้นตามแหล่งที่มาของคีย์API:

- `PERPLEXITY_API_KEY` หรือ `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` หรือ `sk-or-...` → `https://openrouter.ai/api/v1`
- รูปแบบคีย์ที่ไม่รู้จัก → OpenRouter (ทางเลือกสำรองที่ปลอดภัย)

### โมเดล Perplexity ที่พร้อมใช้งาน

| โมเดล                                                   | คำอธิบาย                                      | เหมาะสำหรับ     |
| ------------------------------------------------------- | --------------------------------------------- | --------------- |
| `perplexity/sonar`                                      | Q&A รวดเร็วพร้อมค้นหาเว็บ | ค้นหาด่วน       |
| `perplexity/sonar-pro` (ค่าเริ่มต้น) | การให้เหตุผลหลายขั้นตอนพร้อมค้นหาเว็บ         | คำถามซับซ้อน    |
| `perplexity/sonar-reasoning-pro`                        | การวิเคราะห์แบบ chain-of-thought              | การวิจัยเชิงลึก |

## web_search

ค้นหาเว็บโดยใช้ผู้ให้บริการที่คุณกำหนดค่าไว้

### ข้อกำหนด

- `tools.web.search.enabled` ต้องไม่เป็น `false` (ค่าเริ่มต้น: เปิดใช้งาน)
- คีย์API สำหรับผู้ให้บริการที่เลือก:
  - **Brave**: `BRAVE_API_KEY` หรือ `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, หรือ `tools.web.search.perplexity.apiKey`

### คอนฟิก

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### พารามิเตอร์ของเครื่องมือ

- `query` (จำเป็น)
- `count` (1–10; ค่าเริ่มต้นมาจากคอนฟิก)
- `country` (ไม่บังคับ): รหัสประเทศ 2 ตัวอักษรสำหรับผลลัพธ์ตามภูมิภาค (เช่น "DE", "US", "ALL") หากไม่ระบุ Brave จะเลือกภูมิภาคเริ่มต้นของตน If omitted, Brave chooses its default region.
- `search_lang` (ไม่บังคับ): รหัสภาษา ISO สำหรับผลการค้นหา (เช่น "de", "en", "fr")
- `ui_lang` (ไม่บังคับ): รหัสภาษา ISO สำหรับองค์ประกอบ UI
- `freshness` (ไม่บังคับ เฉพาะ Brave): กรองตามเวลาการค้นพบ (`pd`, `pw`, `pm`, `py`, หรือ `YYYY-MM-DDtoYYYY-MM-DD`)

**ตัวอย่าง:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

ดึง URL และสกัดเนื้อหาที่อ่านง่าย

### ข้อกำหนดของ web_fetch

- `tools.web.fetch.enabled` ต้องไม่เป็น `false` (ค่าเริ่มต้น: เปิดใช้งาน)
- ตัวเลือกสำรอง Firecrawl: ตั้งค่า `tools.web.fetch.firecrawl.apiKey` หรือ `FIRECRAWL_API_KEY`

### คอนฟิก web_fetch

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### พารามิเตอร์เครื่องมือ web_fetch

- `url` (จำเป็น เฉพาะ http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (ตัดความยาวหน้าที่ยาว)

หมายเหตุ:

- `web_fetch` ใช้ Readability (สกัดเนื้อหาหลัก) ก่อน จากนั้นใช้ Firecrawl (หากตั้งค่าไว้) หากทั้งสองล้มเหลว เครื่องมือจะส่งคืนข้อผิดพลาด If both fail, the tool returns an error.
- คำขอ Firecrawl ใช้โหมดหลบเลี่ยงบอตและแคชผลลัพธ์เป็นค่าเริ่มต้น
- `web_fetch` ส่ง User-Agent แบบ Chrome และ `Accept-Language` เป็นค่าเริ่มต้น; สามารถเขียนทับ `userAgent` หากจำเป็น
- `web_fetch` บล็อกชื่อโฮสต์ส่วนตัว/ภายในและตรวจสอบการรีไดเร็กต์ซ้ำ (จำกัดด้วย `maxRedirects`)
- `maxChars` ถูกจำกัดค่าสูงสุดที่ `tools.web.fetch.maxCharsCap`
- `web_fetch` เป็นการสกัดแบบพยายามอย่างดีที่สุด บางไซต์จำเป็นต้องใช้เครื่องมือเบราว์เซอร์
- ดู [Firecrawl](/tools/firecrawl) สำหรับการตั้งค่าคีย์และรายละเอียดบริการ
- การตอบกลับจะถูกแคช (ค่าเริ่มต้น 15 นาที) เพื่อลดการดึงซ้ำ
- หากคุณใช้โปรไฟล์เครื่องมือ/รายการอนุญาต ให้เพิ่ม `web_search`/`web_fetch` หรือ `group:web`
- หากไม่มีคีย์ Brave, `web_search` จะส่งคืนคำแนะนำการตั้งค่าสั้นๆ พร้อมลิงก์เอกสาร
