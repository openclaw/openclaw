# OpenClaw 🦞 — Trợ lý AI của bạn, trên thiết bị và ứng dụng trò chuyện của bạn

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-banner-light.png">
    <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-banner-dark.png" alt="OpenClaw — Trợ lý AI chạy trên thiết bị của chính bạn.">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=flat-square&label=ci" alt="Trạng thái CI"></a>
  <a href="https://www.npmjs.com/package/openclaw"><img src="https://img.shields.io/npm/v/openclaw?style=flat-square&label=npm" alt="Phiên bản npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/openclaw?style=flat-square" alt="Phiên bản Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="Giấy phép MIT"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=discord&logo=discord&logoColor=white&color=5865F2&style=flat-square" alt="Discord"></a>
</p>

**OpenClaw** là trợ lý trí tuệ nhân tạo (AI) mã nguồn mở có thể chạy trên máy tính của bạn và kết nối với những ứng dụng nhắn tin bạn đang sử dụng, chẳng hạn như Discord, iMessage, Slack, Microsoft Teams, Telegram, WhatsApp cùng hơn 20 nền tảng khác. Dự án cũng có ứng dụng dành cho macOS, iOS, Android, Windows và Linux.

Bạn có thể sử dụng OpenClaw như trợ lý cá nhân trên máy tính của mình hoặc triển khai cho cả nhóm. Cấu hình là yếu tố chính quyết định cách sử dụng.

## Tính năng nổi bật

- **Chạy trên thiết bị của bạn:** dữ liệu trạng thái, bộ nhớ và thông tin xác thực được lưu trên phần cứng của bạn.
- **Kết nối nhiều nền tảng:** trò chuyện với trợ lý qua các dịch vụ nhắn tin được hỗ trợ.
- **Linh hoạt về mô hình AI:** có thể cấu hình nhà cung cấp mô hình được lưu trữ hoặc mô hình chạy cục bộ.
- **Mở rộng chức năng:** sử dụng công cụ, kỹ năng (skills) và plugin để bổ sung tính năng.
- **Nhiều cách điều khiển:** thông qua giao diện web, dòng lệnh (CLI) và các ứng dụng đồng hành được hỗ trợ.

OpenClaw gửi yêu cầu đến nhà cung cấp mô hình và nền tảng trò chuyện mà bạn cấu hình. Một số tùy chọn chẩn đoán có thể được bật riêng. Hãy xem [tài liệu về dữ liệu đo lường và quyền riêng tư](https://docs.openclaw.ai/gateway/telemetry) để biết chi tiết.

## Liên kết hữu ích

- [Trang chủ](https://openclaw.ai)
- [Tài liệu chính thức](https://docs.openclaw.ai)
- [Hướng dẫn bắt đầu](https://docs.openclaw.ai/start/getting-started)
- [Tại sao chọn OpenClaw?](https://docs.openclaw.ai/start/why-openclaw)
- [Câu hỏi thường gặp](https://docs.openclaw.ai/help/faq)
- [Cộng đồng](https://community.openclaw.ai/)
- [DeepWiki](https://deepwiki.com/openclaw/openclaw)

## Cài đặt

Trình cài đặt hỗ trợ macOS, Linux và Windows. Khi cần, trình cài đặt sẽ thiết lập môi trường Node.js tương thích.

### macOS / Linux / WSL2

Mở Terminal và chạy:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Windows PowerShell

Mở PowerShell và chạy:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

### Cài đặt bằng npm

Nếu bạn đã tự quản lý Node.js, có thể cài gói OpenClaw bằng lệnh sau. Phiên bản Node.js được yêu cầu là **24.16 trở lên hoặc 26.1 trở lên**; Node.js 26 được khuyến nghị.

```bash
npm install -g openclaw@latest --allow-scripts=openclaw
```

Lệnh trên dành cho npm 12 hoặc npm 11.16 trở lên. Với npm 11.15 trở xuống, hãy bỏ tùy chọn `--allow-scripts=openclaw`.

Xem [hướng dẫn cài đặt đầy đủ](https://docs.openclaw.ai/install) để biết thêm về Docker, Nix và các phương thức triển khai khác.

## Bắt đầu nhanh

Sau khi cài đặt mới, trình cài đặt sẽ tự động mở quy trình thiết lập. Hãy làm theo hướng dẫn trên màn hình.

Nếu cài OpenClaw trực tiếp bằng npm, pnpm hoặc Bun, hãy chạy:

```bash
openclaw onboard --install-daemon
```

Sau khi hoàn tất thiết lập, kiểm tra Gateway và mở giao diện điều khiển:

```bash
openclaw gateway status
openclaw dashboard
```

Quy trình thiết lập giúp kiểm tra quyền truy cập mô hình AI, tạo thư mục làm việc và cấu hình Gateway. Giao diện Control UI sẽ mở ra để bạn gửi tin nhắn thử nghiệm.

Nếu cần hướng dẫn cấu hình nền tảng nhắn tin hoặc xử lý sự cố, hãy xem [Hướng dẫn bắt đầu](https://docs.openclaw.ai/start/getting-started).

## OpenClaw hoạt động như thế nào?

- **Gateway:** thành phần điều phối cục bộ các phiên làm việc, công cụ, sự kiện và kết nối với các nền tảng.
- **Control UI, CLI và TUI:** các giao diện để kết nối và điều khiển Gateway.
- **Channels (Kênh):** kết nối trợ lý với WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage và những dịch vụ khác.
- **Ứng dụng đồng hành và Nodes:** bổ sung các chức năng như giọng nói, Canvas, camera, màn hình và thao tác trên thiết bị được hỗ trợ.
- **Mô hình AI, công cụ, kỹ năng và plugin:** cho phép lựa chọn nhà cung cấp mô hình và mở rộng khả năng của trợ lý.

Tìm hiểu thêm trong tài liệu về [Gateway](https://docs.openclaw.ai/gateway), [các kênh](https://docs.openclaw.ai/channels), [nền tảng](https://docs.openclaw.ai/platforms), [nhà cung cấp mô hình](https://docs.openclaw.ai/concepts/model-providers), [công cụ](https://docs.openclaw.ai/tools), [kỹ năng](https://docs.openclaw.ai/tools/skills) và [plugin](https://docs.openclaw.ai/plugins).

## Bảo mật

Hãy xem tin nhắn đến từ bên ngoài là dữ liệu **không đáng tin cậy**. Theo mặc định, các kênh hỗ trợ tin nhắn trực tiếp sẽ yêu cầu ghép nối với người gửi chưa được nhận diện. Bạn có thể phê duyệt yêu cầu ghép nối bằng lệnh:

```bash
openclaw pairing approve <channel> <code>
```

Các công cụ trong phiên chính có thể chạy trên máy chủ của bạn nếu bạn chưa cấu hình môi trường sandbox. Trước khi kết nối người dùng khác hoặc mở Gateway để truy cập từ xa, hãy đọc kỹ:

- [Hướng dẫn bảo mật](https://docs.openclaw.ai/gateway/security)
- [Hướng dẫn xử lý rủi ro khi để lộ dịch vụ](https://docs.openclaw.ai/gateway/security/exposure-runbook)
- [Hướng dẫn sandbox](https://docs.openclaw.ai/gateway/sandboxing)

## Tài liệu theo nhu cầu

| Bạn muốn làm gì? | Tài liệu |
| --- | --- |
| Cấu hình mô hình AI và xác thực | [Models](https://docs.openclaw.ai/concepts/models) · [Model providers](https://docs.openclaw.ai/concepts/model-providers) |
| Kết nối ứng dụng nhắn tin | [Channels](https://docs.openclaw.ai/channels) |
| Thêm công cụ, kỹ năng và plugin | [Tools](https://docs.openclaw.ai/tools) · [Skills](https://docs.openclaw.ai/tools/skills) · [Plugins](https://docs.openclaw.ai/plugins) · [ClawHub](https://clawhub.ai) |
| Sử dụng ứng dụng và thiết bị | [Platforms](https://docs.openclaw.ai/platforms) · [Nodes](https://docs.openclaw.ai/nodes) |
| Tìm hiểu lệnh và cú pháp trò chuyện | [CLI](https://docs.openclaw.ai/cli) · [Slash commands](https://docs.openclaw.ai/tools/slash-commands) |
| Cấu hình và vận hành Gateway | [Configuration](https://docs.openclaw.ai/gateway/configuration) · [Architecture](https://docs.openclaw.ai/concepts/architecture) |
| Cập nhật OpenClaw | [Updating](https://docs.openclaw.ai/install/updating) · [Release channels](https://docs.openclaw.ai/install/development-channels) |

## Phát triển dự án

Kho mã nguồn sử dụng **pnpm workspace**. Không hỗ trợ chạy `npm install` tại thư mục gốc của repository.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build
```

Đọc [CONTRIBUTING.md](CONTRIBUTING.md) để biết cách đóng góp và [hướng dẫn thiết lập môi trường phát triển](https://docs.openclaw.ai/start/setup) để bắt đầu làm việc với mã nguồn.

## Quản trị dự án

OpenClaw được phát triển công khai dưới sự quản lý của [OpenClaw Foundation](https://openclaw.org), một tổ chức phi lợi nhuận độc lập theo quy định 501(c)(3). Tổ chức hỗ trợ đội ngũ cốt lõi và ký phát hành các phiên bản. Các nhà tài trợ hỗ trợ dự án nhưng không sở hữu hoặc điều hành dự án. OpenAI là một nhà tài trợ, không phải chủ sở hữu.

## Cộng đồng và đóng góp

Mọi người đều có thể tham gia đóng góp cho OpenClaw. Các đóng góp có sự hỗ trợ của AI cũng được chào đón.

- Báo lỗi hoặc đề xuất tính năng tại [Issue Tracker](https://github.com/openclaw/openclaw/issues/new/choose).
- Trao đổi và nhận hỗ trợ tại [Cộng đồng OpenClaw](https://community.openclaw.ai/).
- Báo cáo lỗ hổng bảo mật theo hướng dẫn trong [SECURITY.md](SECURITY.md).
- Phát triển chức năng mới bằng plugin theo [Plugin SDK](https://docs.openclaw.ai/plugins/building-plugins) và chia sẻ qua [ClawHub](https://clawhub.ai).

OpenClaw được Peter Steinberger cùng cộng đồng xây dựng cho **Molty**, một trợ lý AI có hình tượng tôm hùm không gian. Bạn có thể tìm hiểu thêm về [câu chuyện dự án](https://docs.openclaw.ai/start/lore), [soul.md](https://soul.md), [trang cá nhân của Peter](https://steipete.me) và [lịch sử phát triển dự án](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left).

Xin cảm ơn Mario Zechner vì sự hỗ trợ và dự án [pi](https://github.com/earendil-works/pi), cùng Adam Doppelt vì tên miền lobster.bot.

## Nhà tài trợ

OpenClaw Foundation nhận tài trợ từ Amazon, Lobster Computer Company, Offline Holdings, OpenAI, Red Hat và University of Michigan; đồng thời nhận hỗ trợ hạ tầng từ Blacksmith, Convex, GitHub, NVIDIA và Vercel.

---

## Về bản dịch tiếng Việt

Đây là bản README tiếng Việt của repository fork. Tên lệnh, tên công nghệ, đường dẫn và một số thuật ngữ kỹ thuật được giữ nguyên để bạn có thể làm theo hướng dẫn chính xác. Mã nguồn và tài liệu gốc của dự án vẫn thuộc dự án OpenClaw ban đầu.
