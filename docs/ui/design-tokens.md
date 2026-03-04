# Design Tokens — OpenClaw UI

Toàn bộ design tokens được định nghĩa trong `app/globals.css` dưới dạng **CSS Custom Properties** (variables).

---

## Màu Nền (Backgrounds)

| Token           | Dark      | Light     | Dùng cho                          |
| --------------- | --------- | --------- | --------------------------------- |
| `--bg`          | `#12141a` | `#fafafa` | Background chính của trang        |
| `--bg-elevated` | `#1a1d25` | `#ffffff` | Elevated surface (modal, popover) |
| `--bg-hover`    | `#262a35` | `#f0f0f0` | Hover state background            |

---

## Màu Surface / Card

| Token               | Dark      | Light     | Dùng cho                               |
| ------------------- | --------- | --------- | -------------------------------------- |
| `--card`            | `#181b22` | `#ffffff` | Card, panel background                 |
| `--card-foreground` | `#f4f4f5` | `#18181b` | Text trong card                        |
| `--secondary`       | `#1e2028` | `#f4f4f5` | Secondary surfaces (input bg, pill bg) |

---

## Màu Chữ (Text)

| Token            | Dark      | Light     | Dùng cho                          |
| ---------------- | --------- | --------- | --------------------------------- |
| `--text`         | `#e4e4e7` | `#3f3f46` | Body text                         |
| `--text-strong`  | `#fafafa` | `#18181b` | Headings, labels, emphasized text |
| `--muted`        | `#71717a` | _same_    | Secondary/hint text               |
| `--muted-strong` | `#52525b` | _same_    | Stronger muted text               |

---

## Màu Viền (Borders)

| Token             | Dark      | Light     | Dùng cho           |
| ----------------- | --------- | --------- | ------------------ |
| `--border`        | `#27272a` | `#e4e4e7` | Default borders    |
| `--border-strong` | `#3f3f46` | `#d4d4d8` | Emphasized borders |
| `--input`         | `#27272a` | `#e4e4e7` | Input border       |
| `--ring`          | `#ff5c5c` | _same_    | Focus ring         |

---

## Màu Accent (Brand)

| Token                 | Dark                   | Light                 | Dùng cho                                         |
| --------------------- | ---------------------- | --------------------- | ------------------------------------------------ |
| `--accent`            | `#ff5c5c`              | `#dc2626`             | Primary brand color (buttons, links, indicators) |
| `--accent-hover`      | `#ff7070`              | `#ef4444`             | Hover state của accent                           |
| `--accent-subtle`     | `rgba(255,92,92,0.12)` | `rgba(220,38,38,0.1)` | Subtle tint (active nav, avatar bg)              |
| `--accent-foreground` | `#ffffff`              | _same_                | Chữ trên nền accent                              |

---

## Màu Ngữ Nghĩa (Semantic)

| Token             | Value                                | Dùng cho                          |
| ----------------- | ------------------------------------ | --------------------------------- |
| `--ok`            | `#22c55e` (dark) / `#16a34a` (light) | Trạng thái tốt, connected, active |
| `--ok-subtle`     | `rgba(34,197,94,0.1)`                | Background subtle cho ok          |
| `--warn`          | `#f59e0b`                            | Cảnh báo                          |
| `--danger`        | `#ef4444` (dark) / `#dc2626` (light) | Lỗi, xóa, danger actions          |
| `--danger-subtle` | `rgba(239,68,68,0.1)`                | Background subtle cho danger      |
| `--info`          | `#3b82f6`                            | Thông tin                         |

---

## Typography

| Token         | Value                                   | Dùng cho              |
| ------------- | --------------------------------------- | --------------------- |
| `--font-body` | `var(--font-inter), -apple-system, ...` | Font mặc định         |
| `--mono`      | `"JetBrains Mono", ui-monospace, ...`   | Code, IDs, timestamps |

**Base styles** (`body`):

- `font-size: 14px`
- `line-height: 1.6`
- `letter-spacing: -0.01em`
- `-webkit-font-smoothing: antialiased`

---

## Layout

| Token             | Value   | Dùng cho               |
| ----------------- | ------- | ---------------------- |
| `--nav-width`     | `220px` | Chiều rộng sidebar nav |
| `--topbar-height` | `56px`  | Chiều cao topbar       |

---

## Border Radius

| Token         | Value  | Dùng cho                       |
| ------------- | ------ | ------------------------------ |
| `--radius-sm` | `5px`  | Nhỏ: select, mini badge        |
| `--radius-md` | `8px`  | Trung bình: button, input, tab |
| `--radius-lg` | `10px` | Lớn: card, panel               |

---

## Animations

Được định nghĩa dưới dạng `@keyframes`:

| Animation   | Hiệu ứng                                                                    | Dùng cho             |
| ----------- | --------------------------------------------------------------------------- | -------------------- |
| `rise`      | `opacity: 0, translateY(6px)` → `opacity: 1, translateY(0)` (0.3s ease-out) | Page entry animation |
| `fade-in`   | `opacity: 0` → `opacity: 1`                                                 | Fade in elements     |
| `pulse-dot` | `opacity: 1` ↔ `opacity: 0.5` (0%, 50%, 100%)                               | Status dot pulse     |

**Cách dùng**:

```tsx
// Mọi page top-level đều có:
<div style={{ animation: "rise 0.3s ease-out" }}>
```

---

## Scrollbar Styling

```css
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 9999px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--border-strong);
}
```

---

## Focus & Selection

```css
:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-subtle);
}

::selection {
  background: var(--accent-subtle);
  color: var(--text-strong);
}
```

---

## Theme Switching

Có 2 themes: **dark** (default) và **light**.

| Action     | Cơ chế                        |
| ---------- | ----------------------------- |
| Light mode | `<html data-theme="light">`   |
| Dark mode  | `<html>` (không có attribute) |

**CSS selector**:

```css
:root {
  /* dark theme tokens */
}
:root[data-theme="light"] {
  /* light theme overrides */
}
```

**Lưu vào localStorage**: `"theme"` key → `"dark" | "light" | "system"`

---

## Cách Dùng Design Tokens

Luôn dùng CSS variables thay vì hardcode màu:

```tsx
// ✅ Đúng
<div style={{ color: "var(--text-strong)", background: "var(--card)" }}>

// ❌ Sai
<div style={{ color: "#fafafa", background: "#181b22" }}>
```

Đặc biệt, các màu semantic phải dùng đúng ngữ nghĩa:

- Success/connected → `var(--ok)`
- Error/danger → `var(--danger)`
- Warning → `var(--warn)`
- Info → `var(--info)`
