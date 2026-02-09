---
summary: "Phê duyệt exec, danh sách cho phép và lời nhắc thoát sandbox"
read_when:
  - Cấu hình phê duyệt exec hoặc danh sách cho phép
  - Triển khai UX phê duyệt exec trong ứng dụng macOS
  - Xem xét các lời nhắc thoát sandbox và hệ quả
title: "Phê duyệt Exec"
---

# Phê duyệt exec

Phê duyệt exec là **hàng rào bảo vệ của ứng dụng đồng hành / node host** để cho phép một agent trong sandbox chạy
các lệnh trên host thật (`gateway` hoặc `node`). 25. Hãy hình dung nó như một khóa an toàn: các lệnh chỉ được phép khi policy + allowlist + (tùy chọn) phê duyệt của người dùng đều đồng ý.
26. Exec approvals là **bổ sung** cho tool policy và elevated gating (trừ khi elevated được đặt là `full`, khi đó sẽ bỏ qua approvals).
Chính sách hiệu lực là **nghiêm ngặt hơn** giữa `tools.exec.*` và các giá trị mặc định của phê duyệt; nếu một trường phê duyệt bị bỏ qua, giá trị `tools.exec` sẽ được sử dụng.

Nếu UI của ứng dụng đồng hành **không khả dụng**, mọi yêu cầu cần lời nhắc sẽ
được xử lý bằng **ask fallback** (mặc định: từ chối).

## Phạm vi áp dụng

Phê duyệt exec được thực thi cục bộ trên máy chủ thực thi:

- **gateway host** → tiến trình `openclaw` trên máy gateway
- **node host** → node runner (ứng dụng đồng hành macOS hoặc node host headless)

Phân tách trên macOS:

- **dịch vụ node host** chuyển tiếp `system.run` tới **ứng dụng macOS** qua IPC cục bộ.
- **ứng dụng macOS** thực thi phê duyệt + chạy lệnh trong ngữ cảnh UI.

## Cài đặt và lưu trữ

Phê duyệt được lưu trong một tệp JSON cục bộ trên máy chủ thực thi:

`~/.openclaw/exec-approvals.json`

Lược đồ ví dụ:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Các nút chính sách

### Bảo mật (`exec.security`)

- **deny**: chặn mọi yêu cầu exec trên máy chủ.
- **allowlist**: chỉ cho phép các lệnh trong danh sách cho phép.
- **full**: cho phép mọi thứ (tương đương elevated).

### Ask (`exec.ask`)

- **off**: không bao giờ hỏi.
- **on-miss**: chỉ hỏi khi không khớp danh sách cho phép.
- **always**: hỏi cho mọi lệnh.

### Ask fallback (`askFallback`)

Nếu cần lời nhắc nhưng không có UI truy cập được, fallback quyết định:

- **deny**: chặn.
- **allowlist**: chỉ cho phép nếu khớp danh sách cho phép.
- **full**: cho phép.

## Danh sách cho phép (theo từng tác tử)

Allowlists là **theo từng agent**. Nếu tồn tại nhiều agent, hãy chuyển agent bạn đang
chỉnh sửa trong ứng dụng macOS. Các mẫu là **glob match không phân biệt chữ hoa/thường**.
Các mẫu phải phân giải thành **đường dẫn nhị phân** (các mục chỉ có basename sẽ bị bỏ qua).
Các mục `agents.default` cũ được di chuyển sang `agents.main` khi tải.

Ví dụ:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Mỗi mục trong danh sách cho phép theo dõi:

- **id** UUID ổn định dùng cho nhận diện UI (tùy chọn)
- **last used** dấu thời gian lần dùng gần nhất
- **last used command**
- **last resolved path**

## Tự động cho phép CLI của skill

33. Khi **Auto-allow skill CLIs** được bật, các executable được tham chiếu bởi các skill đã biết sẽ được coi là nằm trong allowlist trên các node (node macOS hoặc node host không giao diện). 34. Tính năng này sử dụng `skills.bins` qua Gateway RPC để lấy danh sách bin của skill. 35. Tắt tính năng này nếu bạn muốn các allowlist thủ công nghiêm ngặt.

## Safe bins (chỉ stdin)

36. `tools.exec.safeBins` định nghĩa một danh sách nhỏ các binary **chỉ dùng stdin** (ví dụ `jq`) có thể chạy ở chế độ allowlist **mà không cần** các mục allowlist rõ ràng. Các bin an toàn từ chối
    các đối số tệp theo vị trí và các token dạng đường dẫn, vì vậy chúng chỉ có thể thao tác trên luồng đầu vào.
    Ghép chuỗi shell và chuyển hướng không được tự động cho phép trong chế độ allowlist.

39. Ghép lệnh shell (`&&`, `||`, `;`) được cho phép khi mọi phân đoạn cấp cao nhất đều thỏa mãn allowlist (bao gồm safe bins hoặc auto-allow từ skill). 40. Chuyển hướng vẫn không được hỗ trợ trong chế độ allowlist.
40. Thay thế lệnh (`$()` / backticks) bị từ chối trong quá trình phân tích allowlist, kể cả bên trong dấu ngoặc kép; hãy dùng dấu ngoặc đơn nếu bạn cần văn bản `$()` theo nghĩa đen.

Safe bins mặc định: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Chỉnh sửa bằng Control UI

42. Sử dụng **Control UI → Nodes → Exec approvals** để chỉnh sửa các giá trị mặc định, ghi đè theo từng agent và allowlists. Chọn một phạm vi (Defaults hoặc một agent), điều chỉnh chính sách,
    thêm/xóa các mẫu allowlist, rồi **Save**. 44. UI hiển thị metadata **last used** cho từng pattern để bạn có thể giữ danh sách gọn gàng.

Bộ chọn đích chọn **Gateway** (phê duyệt cục bộ) hoặc một **Node**. Các node
phải quảng bá `system.execApprovals.get/set` (ứng dụng macOS hoặc node host headless).
47. Nếu một node chưa quảng bá exec approvals, hãy chỉnh sửa trực tiếp tệp cục bộ `~/.openclaw/exec-approvals.json` của nó.

CLI: `openclaw approvals` hỗ trợ chỉnh sửa gateway hoặc node (xem [Approvals CLI](/cli/approvals)).

## Luồng phê duyệt

48. Khi cần có prompt, gateway sẽ phát `exec.approval.requested` tới các client của operator.
49. Control UI và ứng dụng macOS sẽ xử lý thông qua `exec.approval.resolve`, sau đó gateway chuyển tiếp yêu cầu đã được phê duyệt tới node host.

Khi cần phê duyệt, công cụ exec sẽ trả về ngay với một id phê duyệt. Sử dụng id đó để
tương quan các sự kiện hệ thống sau này (`Exec finished` / `Exec denied`). If no decision arrives before the
timeout, the request is treated as an approval timeout and surfaced as a denial reason.

Hộp thoại xác nhận bao gồm:

- lệnh + đối số
- cwd
- id tác tử
- đường dẫn executable đã phân giải
- metadata về host + chính sách

Hành động:

- **Allow once** → chạy ngay
- **Always allow** → thêm vào danh sách cho phép + chạy
- **Deny** → chặn

## Chuyển tiếp phê duyệt tới các kênh chat

You can forward exec approval prompts to any chat channel (including plugin channels) and approve
them with `/approve`. This uses the normal outbound delivery pipeline.

Cấu hình:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Trả lời trong chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### Luồng IPC trên macOS

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Ghi chú bảo mật:

- Chế độ socket Unix `0600`, token được lưu trong `exec-approvals.json`.
- Kiểm tra peer cùng UID.
- Thách thức/đáp ứng (nonce + token HMAC + hash yêu cầu) + TTL ngắn.

## Sự kiện hệ thống

Vòng đời exec được hiển thị dưới dạng thông điệp hệ thống:

- `Exec running` (chỉ khi lệnh vượt quá ngưỡng thông báo đang chạy)
- `Exec finished`
- `Exec denied`

Chúng được đăng lên phiên của agent sau khi node báo cáo sự kiện.
Phê duyệt exec trên gateway-host phát ra cùng các sự kiện vòng đời khi lệnh kết thúc (và tùy chọn khi chạy lâu hơn ngưỡng).
Các exec được kiểm soát bằng phê duyệt tái sử dụng id phê duyệt làm `runId` trong các thông điệp này để dễ tương quan.

## Hệ quả

- **full** rất mạnh; ưu tiên dùng danh sách cho phép khi có thể.
- **ask** giúp bạn luôn theo dõi trong khi vẫn cho phép phê duyệt nhanh.
- Danh sách cho phép theo từng tác tử ngăn việc phê duyệt của tác tử này rò rỉ sang tác tử khác.
- Phê duyệt chỉ áp dụng cho các yêu cầu exec trên host từ **những bên gửi được ủy quyền**. Unauthorized senders cannot issue `/exec`.
- `/exec security=full` là một tiện ích ở cấp phiên cho các toán tử được ủy quyền và được thiết kế để bỏ qua phê duyệt.
  Để chặn cứng exec trên host, đặt bảo mật phê duyệt thành `deny` hoặc từ chối công cụ `exec` thông qua chính sách công cụ.

Liên quan:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
