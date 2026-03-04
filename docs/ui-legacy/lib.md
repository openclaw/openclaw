# Thư Viện `lib/` — OpenClaw UI (`ui/`)

---

## `gateway.ts` — `GatewayBrowserClient`

WebSocket client, tương tự `ui-next/lib/gateway.ts` nhưng có thêm nhiều tính năng.

### Khởi tạo

```ts
const client = new GatewayBrowserClient({
  url: string,
  token?: string,
  password?: string,
  clientName: string,
  mode: string,        // "webchat" | ...
  instanceId: string,  // UUID (clientInstanceId)
  onHello?: (hello: GatewayHelloOk) => void,
  onEvent?: (evt: GatewayEventFrame) => void,
  onClose?: (info: { code, reason, error? }) => void,
  onGap?: (info: { expected, received }) => void,
});
client.start();
client.stop();
```

### Methods

- `client.request<T>(method, params?)` → `Promise<T>`
- `client.connected` (getter)

### `GatewayHelloOk` type

```ts
type GatewayHelloOk = {
  server: { version: string; ... };
  auth: { deviceToken?: string; ... };
  snapshot?: {
    presence?: PresenceEntry[];
    health?: HealthSnapshot;
    sessionDefaults?: { mainSessionKey, mainKey, defaultAgentId, scope };
    updateAvailable?: UpdateAvailable;
  };
};
```

### `resolveGatewayErrorDetailCode(error)`

Utility để extract error code từ gateway error response.

---

## `storage.ts` — LocalStorage Settings

### `UiSettings` type

```ts
type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: "dark" | "light" | "system";
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // 0.4–0.7
  navCollapsed: boolean;
  navGroupsCollapsed: Record<string, boolean>;
  locale?: string; // i18n locale
};
```

**Key**: `"openclaw.control.settings.v1"`

**Thêm `locale`** so với `ui-next/`: Hỗ trợ i18n  
**Thêm `navCollapsed`**: Nav có thể collapse trong `ui/` (toggle button)  
**Thêm `navGroupsCollapsed`**: Groups trong nav độc lập collapse

---

## `navigation.ts` — Routing

Không có router framework. Navigation là URL sync thủ công.

### `tabFromPath(pathname, basePath?)`

```ts
// "/" → "chat" (default)
// "/chat" → "chat"
// "/sessions" → "sessions"
tabFromPath(location.pathname, host.basePath);
```

### `pathForTab(tab, basePath?)`

```ts
pathForTab("sessions"); // → "/sessions"
pathForTab("chat"); // → "/chat"
```

### `inferBasePathFromPathname(pathname)`

Tự động infer base path khi app được serve dưới subdirectory.  
Ví dụ: `/myapp/chat` → basePath = `/myapp`

### `TAB_GROUPS`

```ts
const TAB_GROUPS = [
  { label: "chat", tabs: ["chat"] },
  { label: "control", tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"] },
  { label: "agent", tabs: ["agents", "skills", "nodes"] },
  { label: "settings", tabs: ["config", "debug", "logs"] },
];
```

---

## `format.ts` — Format Utilities

Tương tự `ui-next/lib/format.ts` nhưng là bản gốc:

| Function                      | Mô tả                               |
| ----------------------------- | ----------------------------------- |
| `formatRelativeTimestamp(ms)` | "5 minutes ago" / "just now"        |
| `formatDurationHuman(ms)`     | "1.5s" / "2m 30s"                   |
| `formatMs(ms?)`               | `toLocaleString()` hoặc "n/a"       |
| `formatList(values?)`         | "a, b, c" hoặc "none"               |
| `clampText(value, max=120)`   | Cắt với "…"                         |
| `truncateText(value, max)`    | `{ text, truncated, total }`        |
| `toNumber(value, fallback)`   | Parse string → number               |
| `parseList(input)`            | Split bằng dấu phẩy/newline         |
| `formatSessionTokens(row)`    | "1234 / 5678"                       |
| `formatNextRun(ms?)`          | "Mon, 2/28 10:30 AM (in 5 minutes)" |

---

## `markdown.ts` — Markdown Renderer

**Pipeline**: `marked` → `DOMPurify`

```ts
toSanitizedMarkdownHtml(markdown: string): string
```

### Giới hạn (để hiệu suất)

| Constant                   | Value         | Mô tả                           |
| -------------------------- | ------------- | ------------------------------- |
| `MARKDOWN_CHAR_LIMIT`      | 140,000 chars | Tối đa input nhận               |
| `MARKDOWN_PARSE_LIMIT`     | 40,000 chars  | Nếu vượt → render as `<pre>`    |
| `MARKDOWN_CACHE_LIMIT`     | 200 entries   | LRU cache size                  |
| `MARKDOWN_CACHE_MAX_CHARS` | 50,000 chars  | Cache chỉ dành cho nội dung nhỏ |

### DOMPurify Config

```ts
ALLOWED_TAGS: ["a","b","blockquote","br","code","del","em","h1".."h4","hr","i",
               "li","ol","p","pre","strong","table","tbody","td","th","thead","tr","ul","img"]
ALLOWED_ATTR: ["class","href","rel","target","title","start","src","alt"]
```

### Auto Link Safety

Tất cả `<a>` tags tự động thêm `rel="noreferrer noopener"` + `target="_blank"`.

### HTML Escaping

HTML thô trong markdown bị **escape thành text** (không render), để tránh confusing UX khi paste error pages.

---

## `icons.ts` — SVG Icons

```ts
import { icons } from "./icons.ts";

// Usage in templates:
html`<span>${icons.settings}</span>`;
```

### Danh sách icons

`arrows`, `barChart`, `book`, `bug`, `check`, `chevronDown`, `chevronRight`, `chevronUp`, `clock`, `copy`, `download`, `edit`, `externalLink`, `file`, `fileText`, `folder`, `globe`, `info`, `link`, `loader`, `lock`, `logOut`, `maximize`, `menu`, `messageSquare`, `minimize`, `monitor`, `moon`, `moreHorizontal`, `paperclip`, `plus`, `radio`, `refresh`, `save`, `scrollText`, `search`, `send`, `settings`, `sliders`, `star`, `sun`, `trash`, `upload`, `user`, `x`, `zap`, `maximize2`, `minimize2`

---

## `theme.ts` + `theme-transition.ts` — Theme System

### ThemeMode

```ts
type ThemeMode = "dark" | "light" | "system";
```

### Áp dụng theme

- `"light"` → `<html data-theme="light">`
- `"dark"` → remove attribute
- `"system"` → theo `prefers-color-scheme` media query

### Theme Transition (View Transitions API)

**Animated circle wipe** khi switch theme — sử dụng CSS View Transitions API:

```css
@keyframes theme-circle-transition {
  0% {
    clip-path: circle(0% at var(--theme-switch-x) var(--theme-switch-y));
  }
  100% {
    clip-path: circle(150% at var(--theme-switch-x) var(--theme-switch-y));
  }
}
```

The `--theme-switch-x` and `--theme-switch-y` CSS variables được đặt bằng tọa độ click của mouse → circle expand từ điểm click.

---

## `uuid.ts` — UUID Generation

```ts
generateUUID(): string
// Dùng crypto.randomUUID() hoặc fallback manual generation
```

---

## `device-auth.ts` + `device-identity.ts`

Tương tự `ui-next/` — quản lý device identity (Ed25519) và auth token.

---

## `assistant-identity.ts`

```ts
normalizeAssistantIdentity({
  name?: string,
  avatar?: string,
  agentId?: string
}): { name: string, avatar: string, agentId?: string }
```

Xử lý avatar URL (data:// hoặc https://).

---

## `presenter.ts`

Các helpers format dữ liệu để hiển thị — bridge giữa raw types và UI presentation.

---

## `tool-display.ts` + `tool-display.json`

Config hiển thị tên/mô tả cho các tools. `tool-display.json` là file data map `toolId → { label, description, ... }`.

---

## `text-direction.ts`

```ts
getTextDirection(text: string): "ltr" | "rtl" | "auto"
```

Detect RTL text để đặt `dir` attribute đúng cho chat messages.

---

## `i18n/` — Internationalization

### API

```ts
import { t, I18nController, isSupportedLocale } from "../i18n/index.ts";

// Trong Lit component:
private i18nController = new I18nController(this); // auto re-render khi locale thay đổi

// Sử dụng:
t("tabs.chat")                // "Chat"
t("tabs.sessions")            // "Sessions"
t("nav.control")              // "Control"
t("common.ok")                // "OK"
t("chat.disconnected")        // "Gateway disconnected"
```

### Locales

Nằm trong `src/i18n/locales/` — hỗ trợ nhiều ngôn ngữ.
Language setting lưu trong `UiSettings.locale`.

---

## `app-poll.ts` — Polling

```ts
startNodesPolling(host); // Poll nodes status định kỳ
stopNodesPolling(host);

startLogsPolling(host); // Poll logs khi tab=logs đang active
stopLogsPolling(host);

startDebugPolling(host); // Poll debug info khi tab=debug
stopDebugPolling(host);
```

Sử dụng `setInterval` với cleanup khi `disconnectedCallback`.
