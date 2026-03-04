# OpenClaw UI — Tài Liệu

Thư mục này chứa tài liệu kỹ thuật của dự án `ui-next` — giao diện web quản trị OpenClaw.

## Mục lục

| Tài liệu                                     | Nội dung                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| [architecture.md](./architecture.md)         | Kiến trúc tổng quan, cây thư mục, stack công nghệ                         |
| [pages.md](./pages.md)                       | Mô tả chi tiết từng trang (route) trong ứng dụng                          |
| [components.md](./components.md)             | Các shared component: `Nav`, `Topbar`                                     |
| [lib.md](./lib.md)                           | Các thư viện/utility trong `lib/`: gateway, storage, hooks, types, format |
| [design-tokens.md](./design-tokens.md)       | Hệ thống design token CSS (màu sắc, typography, layout, animation)        |
| [gateway-protocol.md](./gateway-protocol.md) | Giao thức WebSocket gateway — cách UI giao tiếp với backend               |

## Công nghệ

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript 5 + React 19
- **Styling**: Tailwind CSS v4 + CSS Variables (design tokens)
- **Font**: Inter (Google Fonts)
- **Cổng mặc định**: `5174` (`npm run dev`)
