---
summary: "Trình hướng dẫn onboarding CLI: thiết lập có hướng dẫn cho gateway, workspace, kênh và skills"
read_when:
  - Chạy hoặc cấu hình trình hướng dẫn onboarding
  - Thiết lập một máy mới
title: "Trình hướng dẫn Onboarding (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Trình hướng dẫn Onboarding (CLI)

34. Trình hướng dẫn onboarding là cách **được khuyến nghị** để thiết lập OpenClaw trên macOS,
    Linux hoặc Windows (qua WSL2; khuyến nghị mạnh mẽ).
35. Nó cấu hình Gateway cục bộ hoặc kết nối Gateway từ xa, cùng với các kênh, skill
    và các giá trị mặc định của workspace trong một luồng hướng dẫn duy nhất.

```bash
openclaw onboard
```

<Info>
Fastest first chat: open the Control UI (no channel setup needed). 37. Chạy
`openclaw dashboard` và chat trong trình duyệt. 38. Tài liệu: [Dashboard](/web/dashboard).
</Info>

Để cấu hình lại sau này:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
39. `--json` không đồng nghĩa với chế độ không tương tác. 32. Đối với script, hãy dùng `--non-interactive`.
</Note>

<Tip>
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). 42. Cách dễ nhất: `openclaw configure --section web`
để lưu `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

Trình hướng dẫn bắt đầu với **QuickStart** (mặc định) so với **Advanced** (toàn quyền kiểm soát).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Gateway cục bộ (local loopback)
    - Workspace mặc định (hoặc workspace hiện có)
    - Cổng Gateway **18789**
    - Xác thực Gateway **Token** (tự tạo, ngay cả trên loopback)
    - Phơi bày Tailscale **Tắt**
    - DM Telegram + WhatsApp mặc định dùng **allowlist** (bạn sẽ được nhắc nhập số điện thoại)
  </Tab>
  <Tab title="Advanced (full control)">
    - Hiển thị mọi bước (chế độ, workspace, gateway, kênh, daemon, skills).
  </Tab>
</Tabs>

## Những gì trình hướng dẫn cấu hình

**Chế độ cục bộ (mặc định)** sẽ hướng dẫn bạn qua các bước sau:

1. 44. **Model/Auth** — Anthropic API key (khuyến nghị), OAuth, OpenAI hoặc các nhà cung cấp khác. 45. Chọn một model mặc định.
2. **Workspace** — Location for agent files (default `~/.openclaw/workspace`). 47. Tạo các tệp bootstrap ban đầu.
3. **Gateway** — Cổng, địa chỉ bind, chế độ xác thực, phơi bày Tailscale.
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, hoặc iMessage.
5. **Daemon** — Cài đặt LaunchAgent (macOS) hoặc systemd user unit (Linux/WSL2).
6. **Health check** — Khởi động Gateway và xác minh đang chạy.
7. **Skills** — Cài đặt các skills được khuyến nghị và các phụ thuộc tùy chọn.

<Note>
48. Chạy lại trình hướng dẫn sẽ **không** xóa bất cứ thứ gì trừ khi bạn chủ động chọn **Reset** (hoặc truyền `--reset`).
33. Nếu cấu hình không hợp lệ hoặc chứa các khóa legacy, trình hướng dẫn sẽ yêu cầu bạn chạy `openclaw doctor` trước.
</Note>

50. **Chế độ Remote** chỉ cấu hình client cục bộ để kết nối tới một Gateway ở nơi khác.
    It does **not** install or change anything on the remote host.

## Thêm một tác tử khác

Use `openclaw agents add <name>` to create a separate agent with its own workspace,
sessions, and auth profiles. Running without `--workspace` launches the wizard.

Những gì nó thiết lập:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Ghi chú:

- Workspace mặc định tuân theo `~/.openclaw/workspace-<agentId>`.
- Thêm `bindings` để định tuyến tin nhắn đến (trình hướng dẫn có thể làm việc này).
- Cờ không tương tác: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Tham khảo đầy đủ

Để xem phân tích chi tiết từng bước, scripting không tương tác, thiết lập Signal,
RPC API, và danh sách đầy đủ các trường cấu hình mà trình hướng dẫn ghi, hãy xem
[Wizard Reference](/reference/wizard).

## Tài liệu liên quan

- Tham chiếu lệnh CLI: [`openclaw onboard`](/cli/onboard)
- Onboarding ứng dụng macOS: [Onboarding](/start/onboarding)
- Nghi thức chạy lần đầu của tác tử: [Agent Bootstrapping](/start/bootstrapping)
