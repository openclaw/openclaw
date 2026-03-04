# Shared Components — OpenClaw UI

---

## `<Nav />` — `components/nav.tsx`

Sidebar navigation, chiếm `grid-area: nav` trong shell layout.

### Props

Không có props — component tự lấy pathname qua `usePathname()` (Next.js).

### Cấu trúc

```
<nav>
  ├── Group: "Main"
  │     ├── Overview    /
  │     ├── Chat        /chat
  │     ├── Agents      /agents
  │     └── Sessions    /sessions
  ├── Group: "Configure"
  │     ├── Channels    /channels
  │     ├── Skills      /skills
  │     ├── Automations /cron
  │     └── Config      /config
  └── Group: "System"
        ├── Logs        /logs
        └── Settings    /settings
```

### Active State Detection

```ts
const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
```

> Dùng `startsWith` để hỗ trợ nested routes (vd: `/agents/123` vẫn active `/agents`).

### Visual Indicators (khi active)

- Background: `var(--bg-hover)`
- Màu text: `var(--text-strong)`, font-weight 500
- **Accent bar**: Thanh dọc đỏ (`var(--accent)`) bên trái, cao 60%, width 2px

### Hover Effect

Dùng inline `onMouseEnter` / `onMouseLeave` thay vì CSS `:hover` vì styles được định nghĩa inline.

### Icons

Tất cả icon là SVG inline (`viewBox="0 0 24 24"`, `strokeWidth={1.5}`, `strokeLinecap="round"`):

| Tên hàm        | Icon path         |
| -------------- | ----------------- |
| `IconHome`     | Ngôi nhà          |
| `IconChat`     | Chat bubble       |
| `IconAgents`   | Person silhouette |
| `IconChannels` | Phone             |
| `IconConfig`   | Gear/settings cog |
| `IconSessions` | 3 rows (database) |
| `IconSkills`   | Star/polygon      |
| `IconCron`     | Clock             |
| `IconLogs`     | File with lines   |
| `IconSettings` | Settings circle   |

### Types bên trong

```ts
interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}
```

---

## `<Topbar />` — `components/topbar.tsx`

Header bar trên cùng, chiếm `grid-area: topbar` (full width, 56px).

### Props

Không có props.

### Sections

#### Left — Brand

- Logo icon (SVG lightning bolt) trên nền `var(--accent)`, border-radius 7px
- Text "OpenClaw" (font-weight 600)
- Sub-text "Control" (uppercase, letter-spacing, muted)

#### Right

1. **Connection Status pill**:
   - Dot xanh (`var(--ok)`) + text `localhost` (mono font)
   - Hiện đang là static, chưa dynamic
2. **Theme Toggle**:
   - 3 nút: Dark 🌙 | System 🖥 | Light ☀️
   - Nút active: background `var(--accent)`, color `white`

### Theme Logic

```ts
type Theme = "dark" | "light" | "system";
```

**Persistence**: `localStorage.setItem("theme", t)`

**Áp dụng theme**:

- `"light"` → `document.documentElement.setAttribute("data-theme", "light")`
- `"dark"` → `document.documentElement.removeAttribute("data-theme")`
- `"system"` → cũng removeAttribute (chưa implement system preference)

**SSR-safe**: Dùng `useSyncExternalStore` với `getThemeServerSnapshot` trả về `"dark"`.

### Lưu ý

- `backdropFilter: "blur(12px)"` để có hiệu ứng glassmorphism khi scroll
- `position: "sticky"`, `zIndex: 40`

---

## Cách thêm component mới

1. Tạo file trong `components/` (ví dụ: `components/badge.tsx`)
2. Export named export (không dùng `default`)
3. Nếu dùng hooks → thêm `"use client"` ở đầu file
4. Import vào page: `import { Badge } from "@/components/badge"`

> Hiện tại chưa có component library (Radix, shadcn...). Tất cả đều dùng inline styles với design tokens.
