---
summary: "Lệnh Doctor: kiểm tra sức khỏe, di chuyển cấu hình và các bước sửa chữa"
read_when:
  - Thêm hoặc chỉnh sửa các migration của doctor
  - Giới thiệu các thay đổi cấu hình gây phá vỡ tương thích
title: "Doctor"
x-i18n:
  source_path: gateway/doctor.md
  source_hash: df7b25f60fd08d50
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:22Z
---

# Doctor

`openclaw doctor` là công cụ sửa chữa + migration cho OpenClaw. Nó khắc phục cấu hình/trạng thái lỗi thời, kiểm tra sức khỏe và cung cấp các bước sửa chữa có thể hành động.

## Khởi động nhanh

```bash
openclaw doctor
```

### Headless / tự động hóa

```bash
openclaw doctor --yes
```

Chấp nhận giá trị mặc định mà không cần nhắc (bao gồm các bước khởi động lại/dịch vụ/sandbox khi áp dụng).

```bash
openclaw doctor --repair
```

Áp dụng các sửa chữa được khuyến nghị mà không cần nhắc (sửa chữa + khởi động lại khi an toàn).

```bash
openclaw doctor --repair --force
```

Áp dụng cả các sửa chữa mạnh (ghi đè cấu hình supervisor tùy chỉnh).

```bash
openclaw doctor --non-interactive
```

Chạy không cần nhắc và chỉ áp dụng các migration an toàn (chuẩn hóa cấu hình + di chuyển trạng thái trên đĩa). Bỏ qua các hành động khởi động lại/dịch vụ/sandbox cần xác nhận của con người.
Các migration trạng thái cũ chạy tự động khi được phát hiện.

```bash
openclaw doctor --deep
```

Quét các dịch vụ hệ thống để tìm các cài đặt gateway bổ sung (launchd/systemd/schtasks).

Nếu bạn muốn xem lại thay đổi trước khi ghi, hãy mở tệp cấu hình trước:

```bash
cat ~/.openclaw/openclaw.json
```

## Nó làm gì (tóm tắt)

- Tùy chọn cập nhật trước khi chạy cho các cài đặt git (chỉ tương tác).
- Kiểm tra độ mới của giao thức UI (xây dựng lại Control UI khi schema giao thức mới hơn).
- Kiểm tra sức khỏe + nhắc khởi động lại.
- Tóm tắt trạng thái Skills (đủ điều kiện/thiếu/bị chặn).
- Chuẩn hóa cấu hình cho các giá trị cũ.
- Cảnh báo ghi đè nhà cung cấp OpenCode Zen (`models.providers.opencode`).
- Migration trạng thái cũ trên đĩa (sessions/thư mục agent/xác thực WhatsApp).
- Kiểm tra tính toàn vẹn và quyền của trạng thái (sessions, transcripts, thư mục state).
- Kiểm tra quyền tệp cấu hình (chmod 600) khi chạy cục bộ.
- Sức khỏe xác thực mô hình: kiểm tra hạn OAuth, có thể làm mới token sắp hết hạn và báo cáo trạng thái cooldown/bị vô hiệu của hồ sơ xác thực.
- Phát hiện thư mục workspace dư (`~/openclaw`).
- Sửa chữa image sandbox khi sandboxing được bật.
- Migration dịch vụ cũ và phát hiện gateway dư.
- Kiểm tra runtime của Gateway (dịch vụ đã cài nhưng không chạy; nhãn launchd được cache).
- Cảnh báo trạng thái kênh (được thăm dò từ gateway đang chạy).
- Kiểm toán cấu hình supervisor (launchd/systemd/schtasks) với tùy chọn sửa chữa.
- Kiểm tra thực hành tốt runtime của Gateway (Node vs Bun, đường dẫn trình quản lý phiên bản).
- Chẩn đoán xung đột cổng Gateway (mặc định `18789`).
- Cảnh báo bảo mật cho các chính sách DM mở.
- Cảnh báo xác thực Gateway khi không đặt `gateway.auth.token` (chế độ local; đề nghị tạo token).
- Kiểm tra systemd linger trên Linux.
- Kiểm tra cài đặt nguồn (không khớp pnpm workspace, thiếu UI assets, thiếu binary tsx).
- Ghi cấu hình đã cập nhật + metadata của wizard.

## Hành vi chi tiết và lý do

### 0) Cập nhật tùy chọn (cài đặt git)

Nếu đây là bản checkout git và doctor chạy ở chế độ tương tác, nó sẽ đề nghị
cập nhật (fetch/rebase/build) trước khi chạy doctor.

### 1) Chuẩn hóa cấu hình

Nếu cấu hình chứa các dạng giá trị cũ (ví dụ `messages.ackReaction`
không có ghi đè theo kênh), doctor sẽ chuẩn hóa chúng theo schema hiện tại.

### 2) Migration khóa cấu hình cũ

Khi cấu hình chứa các khóa đã bị loại bỏ, các lệnh khác sẽ từ chối chạy và yêu cầu
bạn chạy `openclaw doctor`.

Doctor sẽ:

- Giải thích các khóa cũ được tìm thấy.
- Hiển thị migration đã áp dụng.
- Ghi lại `~/.openclaw/openclaw.json` với schema đã cập nhật.

Gateway cũng tự động chạy các migration của doctor khi khởi động nếu phát hiện
định dạng cấu hình cũ, vì vậy cấu hình lỗi thời được sửa mà không cần can thiệp thủ công.

Các migration hiện tại:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → top-level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) Ghi đè nhà cung cấp OpenCode Zen

Nếu bạn đã thêm thủ công `models.providers.opencode` (hoặc `opencode-zen`), nó sẽ
ghi đè danh mục OpenCode Zen tích hợp từ `@mariozechner/pi-ai`. Điều này có thể
buộc mọi mô hình dùng một API duy nhất hoặc đặt chi phí về 0. Doctor cảnh báo để
bạn có thể gỡ ghi đè và khôi phục định tuyến API + chi phí theo từng mô hình.

### 3) Migration trạng thái cũ (bố cục đĩa)

Doctor có thể di chuyển các bố cục trên đĩa cũ sang cấu trúc hiện tại:

- Kho sessions + transcripts:
  - từ `~/.openclaw/sessions/` sang `~/.openclaw/agents/<agentId>/sessions/`
- Thư mục agent:
  - từ `~/.openclaw/agent/` sang `~/.openclaw/agents/<agentId>/agent/`
- Trạng thái xác thực WhatsApp (Baileys):
  - từ `~/.openclaw/credentials/*.json` cũ (trừ `oauth.json`)
  - sang `~/.openclaw/credentials/whatsapp/<accountId>/...` (id tài khoản mặc định: `default`)

Các migration này theo kiểu best-effort và idempotent; doctor sẽ phát ra cảnh báo
khi để lại bất kỳ thư mục cũ nào làm bản sao lưu. Gateway/CLI cũng tự động
migration sessions cũ + thư mục agent khi khởi động để lịch sử/xác thực/mô hình
nằm trong đường dẫn theo từng tác tử mà không cần chạy doctor thủ công. Xác thực
WhatsApp được cố ý chỉ migration thông qua `openclaw doctor`.

### 4) Kiểm tra tính toàn vẹn trạng thái (lưu phiên, định tuyến và an toàn)

Thư mục state là “thân não” vận hành. Nếu nó biến mất, bạn sẽ mất
sessions, thông tin xác thực, log và cấu hình (trừ khi có bản sao lưu ở nơi khác).

Doctor kiểm tra:

- **Thiếu thư mục state**: cảnh báo mất trạng thái nghiêm trọng, nhắc tạo lại
  thư mục và nhắc rằng không thể khôi phục dữ liệu đã mất.
- **Quyền thư mục state**: xác minh khả năng ghi; đề nghị sửa quyền
  (và phát ra gợi ý `chown` khi phát hiện không khớp owner/group).
- **Thiếu thư mục session**: `sessions/` và thư mục lưu sessions là
  bắt buộc để lưu lịch sử và tránh crash `ENOENT`.
- **Không khớp transcript**: cảnh báo khi các mục session gần đây thiếu
  tệp transcript.
- **Transcript chính “JSONL 1 dòng”**: đánh dấu khi transcript chính chỉ có một
  dòng (lịch sử không tích lũy).
- **Nhiều thư mục state**: cảnh báo khi tồn tại nhiều thư mục `~/.openclaw`
  trên các thư mục home hoặc khi `OPENCLAW_STATE_DIR` trỏ sang nơi khác (lịch sử có thể
  bị chia tách giữa các cài đặt).
- **Nhắc chế độ remote**: nếu `gateway.mode=remote`, doctor nhắc bạn chạy
  trên máy chủ remote (trạng thái nằm ở đó).
- **Quyền tệp cấu hình**: cảnh báo nếu `~/.openclaw/openclaw.json` có thể đọc bởi group/world
  và đề nghị siết chặt về `600`.

### 5) Sức khỏe xác thực mô hình (hạn OAuth)

Doctor kiểm tra các hồ sơ OAuth trong kho xác thực, cảnh báo khi token
sắp hết hạn/đã hết hạn và có thể làm mới khi an toàn. Nếu hồ sơ Anthropic Claude Code
bị lỗi thời, nó đề xuất chạy `claude setup-token` (hoặc dán setup-token).
Lời nhắc làm mới chỉ xuất hiện khi chạy tương tác (TTY); `--non-interactive`
bỏ qua các nỗ lực làm mới.

Doctor cũng báo cáo các hồ sơ xác thực tạm thời không dùng được do:

- cooldown ngắn (giới hạn tốc độ/timeouts/lỗi xác thực)
- vô hiệu dài hơn (lỗi thanh toán/tín dụng)

### 6) Xác thực mô hình Hooks

Nếu đặt `hooks.gmail.model`, doctor sẽ xác thực tham chiếu mô hình so với
catalog và allowlist, và cảnh báo khi nó không phân giải được hoặc bị cấm.

### 7) Sửa chữa image sandbox

Khi sandboxing được bật, doctor kiểm tra các image Docker và đề nghị build hoặc
chuyển sang tên legacy nếu image hiện tại bị thiếu.

### 8) Migration dịch vụ Gateway và gợi ý dọn dẹp

Doctor phát hiện các dịch vụ gateway cũ (launchd/systemd/schtasks) và
đề nghị gỡ chúng và cài đặt dịch vụ OpenClaw với cổng gateway hiện tại.
Nó cũng có thể quét các dịch vụ giống gateway dư và in ra gợi ý dọn dẹp.
Các dịch vụ gateway OpenClaw được đặt tên theo profile được coi là hạng nhất và
không bị gắn cờ là “dư”.

### 9) Cảnh báo bảo mật

Doctor phát ra cảnh báo khi một nhà cung cấp mở DM mà không có allowlist, hoặc
khi một chính sách được cấu hình theo cách nguy hiểm.

### 10) systemd linger (Linux)

Nếu chạy như dịch vụ người dùng systemd, doctor đảm bảo bật lingering để
gateway tiếp tục chạy sau khi đăng xuất.

### 11) Trạng thái Skills

Doctor in ra tóm tắt nhanh các Skills đủ điều kiện/thiếu/bị chặn cho workspace hiện tại.

### 12) Kiểm tra xác thực Gateway (token local)

Doctor cảnh báo khi thiếu `gateway.auth` trên gateway local và đề nghị
tạo token. Dùng `openclaw doctor --generate-gateway-token` để buộc tạo token
trong tự động hóa.

### 13) Kiểm tra sức khỏe Gateway + khởi động lại

Doctor chạy kiểm tra sức khỏe và đề nghị khởi động lại gateway khi có dấu hiệu
không khỏe.

### 14) Cảnh báo trạng thái kênh

Nếu gateway khỏe, doctor chạy thăm dò trạng thái kênh và báo cáo
cảnh báo kèm cách khắc phục đề xuất.

### 15) Kiểm toán + sửa chữa cấu hình supervisor

Doctor kiểm tra cấu hình supervisor đã cài (launchd/systemd/schtasks) để tìm
các mặc định bị thiếu hoặc lỗi thời (ví dụ phụ thuộc network-online của systemd và
độ trễ khởi động lại). Khi phát hiện không khớp, nó khuyến nghị cập nhật và có thể
ghi lại tệp dịch vụ/tác vụ theo mặc định hiện tại.

Ghi chú:

- `openclaw doctor` sẽ hỏi trước khi ghi lại cấu hình supervisor.
- `openclaw doctor --yes` chấp nhận các lời nhắc sửa chữa mặc định.
- `openclaw doctor --repair` áp dụng các sửa chữa được khuyến nghị mà không cần nhắc.
- `openclaw doctor --repair --force` ghi đè cấu hình supervisor tùy chỉnh.
- Bạn luôn có thể buộc ghi lại toàn bộ qua `openclaw gateway install --force`.

### 16) Chẩn đoán runtime + cổng Gateway

Doctor kiểm tra runtime dịch vụ (PID, trạng thái thoát gần nhất) và cảnh báo khi
dịch vụ đã cài nhưng thực tế không chạy. Nó cũng kiểm tra xung đột cổng
trên cổng gateway (mặc định `18789`) và báo cáo các nguyên nhân có khả năng
(x gateway đã chạy, đường hầm SSH).

### 17) Thực hành tốt runtime Gateway

Doctor cảnh báo khi dịch vụ gateway chạy trên Bun hoặc đường dẫn Node do trình
quản lý phiên bản cung cấp (`nvm`, `fnm`, `volta`, `asdf`, v.v.). Các kênh WhatsApp + Telegram yêu cầu Node,
và các đường dẫn do trình quản lý phiên bản có thể bị hỏng sau nâng cấp vì dịch vụ
không nạp shell init của bạn. Doctor đề nghị di chuyển sang cài đặt Node hệ thống
khi có (Homebrew/apt/choco).

### 18) Ghi cấu hình + metadata wizard

Doctor lưu mọi thay đổi cấu hình và đóng dấu metadata wizard để ghi nhận lần chạy doctor.

### 19) Mẹo workspace (sao lưu + hệ thống bộ nhớ)

Doctor gợi ý hệ thống bộ nhớ cho workspace khi thiếu và in mẹo sao lưu
nếu workspace chưa nằm trong git.

Xem [/concepts/agent-workspace](/concepts/agent-workspace) để có hướng dẫn đầy đủ về
cấu trúc workspace và sao lưu git (khuyến nghị GitHub hoặc GitLab riêng tư).
