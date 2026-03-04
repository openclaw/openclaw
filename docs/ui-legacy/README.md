# OpenClaw UI (Legacy) — Tài Liệu

Thư mục này chứa tài liệu kỹ thuật cho dự án `ui/` — giao diện web quản trị OpenClaw thế hệ gốc, xây dựng bằng **Lit** (Web Components).

> 💡 **Lưu ý phân biệt hai dự án UI:**
>
> - `ui/` — **Dự án này** — Web Components với Lit, đầy đủ tính năng, là production UI chính
> - `ui-next/` — Phiên bản mới đang phát triển — Next.js + React, tương đương nhưng đang được migrate

## Mục lục

| Tài liệu                                 | Nội dung                                                        |
| ---------------------------------------- | --------------------------------------------------------------- |
| [architecture.md](./architecture.md)     | Kiến trúc tổng quan, cây thư mục, stack, data flow              |
| [app-component.md](./app-component.md)   | `OpenClawApp` — Web Component trung tâm, state, lifecycle       |
| [views.md](./views.md)                   | Danh sách views/tabs và controller tương ứng                    |
| [lib.md](./lib.md)                       | Các thư viện utility: gateway, storage, format, markdown, icons |
| [styles.md](./styles.md)                 | Hệ thống CSS: design tokens, layout, animation, responsive      |
| [gateway-events.md](./gateway-events.md) | Các sự kiện WebSocket gateway và cách UI xử lý                  |

## Công nghệ

- **Framework**: [Lit 3](https://lit.dev/) — Web Components
- **Build**: Vite 7 (ES Module, TypeScript)
- **Testing**: Vitest 4 (Node + Browser/Playwright)
- **Rendering**: `marked` + `DOMPurify` (Markdown sanitization)
- **Crypto**: `@noble/ed25519` (Ed25519 device auth)
- **I18n**: Custom i18n module (locales trong `src/i18n/`)
- **Dev Port**: `5173`
- **Build Output**: `../dist/control-ui/`
