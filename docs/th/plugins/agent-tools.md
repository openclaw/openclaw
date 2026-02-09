---
summary: "เขียนเครื่องมือเอเจนต์ในปลั๊กอิน(สคีมา เครื่องมือแบบไม่บังคับ รายการอนุญาต)"
read_when:
  - คุณต้องการเพิ่มเครื่องมือเอเจนต์ใหม่ในปลั๊กอิน
  - คุณต้องการทำให้เครื่องมือเป็นแบบเลือกใช้ผ่านรายการอนุญาต
title: "เครื่องมือเอเจนต์ของปลั๊กอิน"
---

# เครื่องมือเอเจนต์ของปลั๊กอิน

ปลั๊กอินของ OpenClaw สามารถลงทะเบียน **เครื่องมือเอเจนต์** (ฟังก์ชัน JSON‑schema) ที่ถูกเปิดเผย
ให้กับ LLM ระหว่างการรันเอเจนต์ เครื่องมือสามารถเป็น **บังคับ** (พร้อมใช้งานเสมอ) หรือ
**ไม่บังคับ** (ต้องเลือกใช้) 7. เครื่องมืออาจเป็น **required** (พร้อมใช้งานเสมอ) หรือ
**optional** (เลือกเปิดใช้ได้)

เครื่องมือเอเจนต์ถูกกำหนดค่าภายใต้ `tools` ในคอนฟิกหลัก หรือกำหนดต่อเอเจนต์ภายใต้
`agents.list[].tools` นโยบายรายการอนุญาต/รายการปฏิเสธควบคุมว่าเอเจนต์
สามารถเรียกใช้เครื่องมือใดได้บ้าง 8. นโยบาย allowlist/denylist ควบคุมว่าเครื่องมือใดบ้างที่เอเจนต์
สามารถเรียกใช้ได้

## เครื่องมือพื้นฐาน

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## เครื่องมือแบบไม่บังคับ(เลือกใช้)

9. เครื่องมือแบบ optional จะ **ไม่** ถูกเปิดใช้งานอัตโนมัติ 10. ผู้ใช้ต้องเพิ่มเครื่องมือเหล่านี้เข้าไปใน
   allowlist ของเอเจนต์

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

เปิดใช้งานเครื่องมือแบบไม่บังคับใน `agents.list[].tools.allow` (หรือแบบส่วนกลาง `tools.allow`):

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

ปุ่ม/ตัวเลือกคอนฟิกอื่นๆที่มีผลต่อความพร้อมใช้งานของเครื่องมือ:

- รายการอนุญาตที่ระบุเฉพาะเครื่องมือของปลั๊กอินจะถูกมองว่าเป็นการเลือกใช้ปลั๊กอิน; เครื่องมือแกนหลักจะยังคง
  เปิดใช้งานอยู่ เว้นแต่คุณจะระบุเครื่องมือแกนหลักหรือกลุ่มไว้ในรายการอนุญาตด้วย
- `tools.profile` / `agents.list[].tools.profile` (รายการอนุญาตฐาน)
- `tools.byProvider` / `agents.list[].tools.byProvider` (การอนุญาต/ปฏิเสธเฉพาะผู้ให้บริการ)
- `tools.sandbox.tools.*` (นโยบายเครื่องมือ sandbox เมื่ออยู่ใน sandbox)

## กฎ + เคล็ดลับ

- ชื่อเครื่องมือต้อง **ไม่** ชนกับชื่อเครื่องมือแกนหลัก; เครื่องมือที่ชนกันจะถูกข้าม
- id ของปลั๊กอินที่ใช้ในรายการอนุญาตต้องไม่ชนกับชื่อเครื่องมือแกนหลัก
- ควรใช้ `optional: true` สำหรับเครื่องมือที่ก่อให้เกิดผลข้างเคียงหรือจำเป็นต้องใช้
  ไบนารี/ข้อมูลรับรองเพิ่มเติม
