---
summary: "OAuth trong OpenClaw: trao đổi token, lưu trữ và các mô hình nhiều tài khoản"
read_when:
  - Bạn muốn hiểu OAuth trong OpenClaw từ đầu đến cuối
  - Bạn gặp vấn đề vô hiệu hóa token / đăng xuất
  - Bạn muốn các luồng xác thực setup-token hoặc OAuth
  - Bạn muốn nhiều tài khoản hoặc định tuyến theo hồ sơ
title: "OAuth"
---

# OAuth

7. OpenClaw hỗ trợ “xác thực thuê bao” thông qua OAuth cho các nhà cung cấp có hỗ trợ (đáng chú ý là **OpenAI Codex (ChatGPT OAuth)**). Đối với các gói đăng ký Anthropic, hãy dùng luồng **setup-token**. Trang này giải thích:

- cách hoạt động của **trao đổi token** OAuth (PKCE)
- **token được lưu ở đâu** (và vì sao)
- cách xử lý **nhiều tài khoản** (hồ sơ + ghi đè theo phiên)

10. OpenClaw cũng hỗ trợ **plugin nhà cung cấp** đi kèm OAuth hoặc luồng khóa API riêng
    flows. 11. Chạy chúng bằng:

```bash
openclaw models auth login --provider <id>
```

## Token sink (vì sao nó tồn tại)

12. Các nhà cung cấp OAuth thường phát hành **refresh token mới** trong các luồng đăng nhập/làm mới. 13. Một số nhà cung cấp (hoặc client OAuth) có thể vô hiệu hóa các refresh token cũ khi một token mới được phát hành cho cùng người dùng/ứng dụng.

Triệu chứng thực tế:

- bạn đăng nhập qua OpenClaw _và_ qua Claude Code / Codex CLI → một trong hai sẽ ngẫu nhiên bị “đăng xuất” sau đó

Để giảm vấn đề này, OpenClaw coi `auth-profiles.json` như một **token sink**:

- runtime đọc thông tin xác thực từ **một nơi duy nhất**
- có thể giữ nhiều hồ sơ và định tuyến chúng một cách xác định

## Lưu trữ (token nằm ở đâu)

Bí mật được lưu **theo từng tác tử**:

- Hồ sơ xác thực (OAuth + khóa API): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Cache runtime (được quản lý tự động; đừng chỉnh sửa): `~/.openclaw/agents/<agentId>/agent/auth.json`

Tệp legacy chỉ dùng để import (vẫn được hỗ trợ, nhưng không phải kho chính):

- `~/.openclaw/credentials/oauth.json` (được import vào `auth-profiles.json` khi dùng lần đầu)

14. Tất cả những điều trên cũng tuân theo `$OPENCLAW_STATE_DIR` (ghi đè thư mục trạng thái). 15. Tham chiếu đầy đủ: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

Chạy `claude setup-token` trên bất kỳ máy nào, sau đó dán vào OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Nếu bạn đã tạo token ở nơi khác, hãy dán thủ công:

```bash
openclaw models auth paste-token --provider anthropic
```

Xác minh:

```bash
openclaw models status
```

## Trao đổi OAuth (cách đăng nhập hoạt động)

Các luồng đăng nhập tương tác của OpenClaw được triển khai trong `@mariozechner/pi-ai` và được kết nối vào các wizard/lệnh.

### Anthropic (Claude Pro/Max) setup-token

Hình dạng luồng:

1. chạy `claude setup-token`
2. dán token vào OpenClaw
3. lưu thành hồ sơ xác thực bằng token (không làm mới)

Đường dẫn wizard là `openclaw onboard` → lựa chọn xác thực `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Hình dạng luồng (PKCE):

1. tạo PKCE verifier/challenge + `state` ngẫu nhiên
2. mở `https://auth.openai.com/oauth/authorize?...`
3. cố gắng bắt callback tại `http://127.0.0.1:1455/auth/callback`
4. nếu callback không thể bind (hoặc bạn ở môi trường remote/headless), hãy dán URL/code chuyển hướng
5. trao đổi tại `https://auth.openai.com/oauth/token`
6. trích xuất `accountId` từ access token và lưu `{ access, refresh, expires, accountId }`

Đường dẫn wizard là `openclaw onboard` → lựa chọn xác thực `openai-codex`.

## Làm mới + hết hạn

Các hồ sơ lưu một mốc thời gian `expires`.

Khi chạy:

- nếu `expires` ở tương lai → dùng access token đã lưu
- nếu đã hết hạn → làm mới (dưới khóa tệp) và ghi đè thông tin xác thực đã lưu

Luồng làm mới diễn ra tự động; bạn thường không cần quản lý token thủ công.

## Nhiều tài khoản (hồ sơ) + định tuyến

Hai mô hình:

### 1. Ưu tiên: tác tử tách biệt

Nếu bạn muốn “cá nhân” và “công việc” không bao giờ tương tác, hãy dùng các tác tử cô lập (phiên + thông tin xác thực + workspace riêng):

```bash
openclaw agents add work
openclaw agents add personal
```

Sau đó cấu hình xác thực theo từng tác tử (wizard) và định tuyến chat đến đúng tác tử.

### 2. Nâng cao: nhiều hồ sơ trong một tác tử

`auth-profiles.json` hỗ trợ nhiều ID hồ sơ cho cùng một nhà cung cấp.

Chọn hồ sơ được dùng:

- toàn cục qua thứ tự cấu hình (`auth.order`)
- theo phiên qua `/model ...@<profileId>`

Ví dụ (ghi đè theo phiên):

- `/model Opus@anthropic:work`

Cách xem các ID hồ sơ hiện có:

- `openclaw channels list --json` (hiển thị `auth[]`)

Tài liệu liên quan:

- [/concepts/model-failover](/concepts/model-failover) (quy tắc luân phiên + cooldown)
- [/tools/slash-commands](/tools/slash-commands) (bề mặt lệnh)
