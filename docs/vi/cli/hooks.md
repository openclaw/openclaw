---
summary: "Tài liệu tham chiếu CLI cho `openclaw hooks` (hook tác tử)"
read_when:
  - Bạn muốn quản lý hook tác tử
  - Bạn muốn cài đặt hoặc cập nhật hook
title: "hooks"
---

# `openclaw hooks`

Quản lý hook tác tử (tự động hóa theo sự kiện cho các lệnh như `/new`, `/reset` và khi gateway khởi động).

Liên quan:

- Hooks: [Hooks](/automation/hooks)
- Hook plugin: [Plugins](/tools/plugin#plugin-hooks)

## Liệt kê tất cả Hook

```bash
openclaw hooks list
```

Liệt kê tất cả các hook được phát hiện từ các thư mục workspace, managed và bundled.

**Tùy chọn:**

- `--eligible`: Chỉ hiển thị các hook đủ điều kiện (đáp ứng yêu cầu)
- `--json`: Xuất dưới dạng JSON
- `-v, --verbose`: Hiển thị thông tin chi tiết bao gồm các yêu cầu còn thiếu

**Ví dụ đầu ra:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Ví dụ (chi tiết):**

```bash
openclaw hooks list --verbose
```

Hiển thị các yêu cầu còn thiếu đối với các hook không đủ điều kiện.

**Ví dụ (JSON):**

```bash
openclaw hooks list --json
```

Trả về JSON có cấu trúc để sử dụng theo cách lập trình.

## Lấy thông tin Hook

```bash
openclaw hooks info <name>
```

Hiển thị thông tin chi tiết về một hook cụ thể.

**Đối số:**

- `<name>`: Tên hook (ví dụ: `session-memory`)

**Tùy chọn:**

- `--json`: Xuất dưới dạng JSON

**Ví dụ:**

```bash
openclaw hooks info session-memory
```

**Đầu ra:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Kiểm tra điều kiện Hook

```bash
openclaw hooks check
```

Hiển thị tóm tắt trạng thái đủ điều kiện của hook (bao nhiêu sẵn sàng so với chưa sẵn sàng).

**Tùy chọn:**

- `--json`: Xuất dưới dạng JSON

**Ví dụ đầu ra:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Bật một Hook

```bash
openclaw hooks enable <name>
```

Bật một hook cụ thể bằng cách thêm nó vào cấu hình của bạn (`~/.openclaw/config.json`).

**Lưu ý:** Các hook do plugin quản lý sẽ hiển thị `plugin:<id>` trong `openclaw hooks list` và
không thể bật/tắt tại đây. Thay vào đó, hãy bật/tắt plugin.

**Đối số:**

- `<name>`: Tên hook (ví dụ: `session-memory`)

**Ví dụ:**

```bash
openclaw hooks enable session-memory
```

**Đầu ra:**

```
✓ Enabled hook: 💾 session-memory
```

**Những gì lệnh thực hiện:**

- Kiểm tra xem hook có tồn tại và đủ điều kiện hay không
- Cập nhật \`hooks.internal.entries.<name>Trang này mô tả hành vi CLI hiện tại.
- Lưu cấu hình xuống đĩa

**Sau khi bật:**

- Khởi động lại gateway để hook được tải lại (khởi động lại ứng dụng menu bar trên macOS, hoặc khởi động lại tiến trình gateway trong môi trường dev).

## Tắt một Hook

```bash
openclaw hooks disable <name>
```

Tắt một hook cụ thể bằng cách cập nhật cấu hình của bạn.

**Đối số:**

- `<name>`: Tên hook (ví dụ: `command-logger`)

**Ví dụ:**

```bash
openclaw hooks disable command-logger
```

**Đầu ra:**

```
⏸ Disabled hook: 📝 command-logger
```

**Sau khi tắt:**

- Khởi động lại gateway để hook được tải lại

## Cài đặt Hook

```bash
openclaw hooks install <path-or-spec>
```

Cài đặt một gói hook từ thư mục/tệp nén cục bộ hoặc từ npm.

**Những gì lệnh thực hiện:**

- Sao chép gói hook vào `~/.openclaw/hooks/<id>`
- Bật các hook đã cài đặt trong `hooks.internal.entries.*`
- Ghi nhận việc cài đặt dưới `hooks.internal.installs`

**Tùy chọn:**

- `-l, --link`: Liên kết một thư mục cục bộ thay vì sao chép (thêm nó vào `hooks.internal.load.extraDirs`)

**Các định dạng lưu trữ được hỗ trợ:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Ví dụ:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## Cập nhật Hook

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Cập nhật các gói hook đã cài đặt (chỉ áp dụng cho cài đặt từ npm).

**Tùy chọn:**

- `--all`: Cập nhật tất cả các gói hook đang được theo dõi
- `--dry-run`: Hiển thị những thay đổi sẽ xảy ra mà không ghi ra đĩa

## Hook đi kèm

### session-memory

Lưu ngữ cảnh phiên vào bộ nhớ khi bạn thực hiện `/new`.

**Bật:**

```bash
openclaw hooks enable session-memory
```

**Đầu ra:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Xem:** [tài liệu session-memory](/automation/hooks#session-memory)

### command-logger

Ghi log tất cả các sự kiện lệnh vào một tệp audit tập trung.

**Bật:**

```bash
openclaw hooks enable command-logger
```

**Đầu ra:** `~/.openclaw/logs/commands.log`

**Xem log:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Xem:** [tài liệu command-logger](/automation/hooks#command-logger)

### soul-evil

Hoán đổi nội dung `SOUL.md` được chèn bằng `SOUL_EVIL.md` trong một khoảng purge hoặc ngẫu nhiên.

**Bật:**

```bash
openclaw hooks enable soul-evil
```

**Xem:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

Chạy `BOOT.md` khi gateway khởi động (sau khi các kênh khởi động).

**Sự kiện**: `gateway:startup`

**Bật**:

```bash
openclaw hooks enable boot-md
```

**Xem:** [tài liệu boot-md](/automation/hooks#boot-md)
