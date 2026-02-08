---
summary: "Schema cấu hình Skills và ví dụ"
read_when:
  - Thêm hoặc chỉnh sửa cấu hình Skills
  - Điều chỉnh danh sách cho phép gói sẵn hoặc hành vi cài đặt
title: "Cấu hình Skills"
x-i18n:
  source_path: tools/skills-config.md
  source_hash: e265c93da7856887
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:30Z
---

# Cấu hình Skills

Tất cả cấu hình liên quan đến skills nằm dưới `skills` trong `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Trường

- `allowBundled`: danh sách cho phép tùy chọn cho **skills gói sẵn** בלבד. Khi được đặt, chỉ
  các skills gói sẵn trong danh sách mới đủ điều kiện (skills được quản lý/workspace không bị ảnh hưởng).
- `load.extraDirs`: các thư mục skill bổ sung để quét (độ ưu tiên thấp nhất).
- `load.watch`: theo dõi các thư mục skill và làm mới ảnh chụp skills (mặc định: true).
- `load.watchDebounceMs`: debounce cho các sự kiện watcher của skill tính bằng mili giây (mặc định: 250).
- `install.preferBrew`: ưu tiên trình cài đặt brew khi có sẵn (mặc định: true).
- `install.nodeManager`: tùy chọn trình cài đặt node (`npm` | `pnpm` | `yarn` | `bun`, mặc định: npm).
  Điều này chỉ ảnh hưởng đến **cài đặt skill**; runtime của Gateway vẫn nên là Node
  (không khuyến nghị Bun cho WhatsApp/Telegram).
- `entries.<skillKey>`: ghi đè theo từng skill.

Các trường theo từng skill:

- `enabled`: đặt `false` để vô hiệu hóa một skill ngay cả khi nó được gói sẵn/cài đặt.
- `env`: biến môi trường được chèn cho lần chạy tác tử (chỉ khi chưa được đặt).
- `apiKey`: tiện ích tùy chọn cho các skills khai báo một biến môi trường chính.

## Ghi chú

- Các khóa dưới `entries` ánh xạ tới tên skill theo mặc định. Nếu một skill định nghĩa
  `metadata.openclaw.skillKey`, hãy dùng khóa đó thay thế.
- Các thay đổi đối với skills sẽ được áp dụng ở lượt tác tử tiếp theo khi watcher được bật.

### Skills sandboxed + biến môi trường

Khi một phiên được **sandboxed**, các tiến trình skill chạy bên trong Docker. Sandbox
**không** kế thừa `process.env` của máy chủ.

Hãy dùng một trong các cách sau:

- `agents.defaults.sandbox.docker.env` (hoặc `agents.list[].sandbox.docker.env` theo từng tác tử)
- bake biến môi trường vào image sandbox tùy chỉnh của bạn

`env` và `skills.entries.<skill>.env/apiKey` toàn cục chỉ áp dụng cho các lần chạy trên **máy chủ**.
