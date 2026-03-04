# Thư Viện `lib/` — OpenClaw UI

---

## `gateway.ts` — GatewayClient

**WebSocket client** chính, không phụ thuộc React.

### Class `GatewayClient`

```ts
const client = new GatewayClient({
  url: "ws://localhost:18789",
  token?: string,
  password?: string,
  onHello?: (hello: GatewayHelloOk) => void,
  onEvent?: (evt: GatewayEventFrame) => void,
  onClose?: (info: { code, reason, error? }) => void,
  onGap?: (info: { expected, received }) => void,
});
client.start();  // bắt đầu kết nối
client.stop();   // dừng và cleanup
```

#### Phương thức public

| Method         | Signature                         | Mô tả                                 |
| -------------- | --------------------------------- | ------------------------------------- |
| `start()`      | `void`                            | Bắt đầu kết nối WebSocket             |
| `stop()`       | `void`                            | Đóng kết nối, reject pending requests |
| `request<T>()` | `(method, params?) => Promise<T>` | Gửi request tới gateway               |
| `connected`    | `boolean` (getter)                | Trạng thái kết nối hiện tại           |

#### Request format

```json
{ "type": "req", "id": "<uuid>", "method": "sessions.list", "params": {} }
```

#### Response format

```json
{ "type": "res", "id": "<uuid>", "ok": true, "payload": { ... } }
// hoặc khi lỗi:
{ "type": "res", "id": "<uuid>", "ok": false, "error": { "code": "...", "message": "..." } }
```

### Reconnect Policy

- Tự động reconnect khi bị ngắt
- Exponential backoff: `backoffMs * 1.7`, tối đa 15 giây
- Khởi đầu: 800ms

### Auth Flow

```
WebSocket OPEN
  → server gửi: { type: "event", event: "connect.challenge", payload: { nonce } }
  → GatewayClient.sendConnect() được gọi
        ├── Load hoặc tạo mới DeviceIdentity (Ed25519 key pair)
        ├── Load stored device token từ localStorage
        ├── Ký payload với private key
        └── Gửi request "connect" với { auth, device, client, scopes, ... }
  → server trả về "hello-ok"
        └── Lưu auth.deviceToken vào localStorage
```

> Nếu không phải secure context (HTTP, không phải localhost), bỏ qua device identity.

### Error Handling

```ts
try {
  const result = await client.request("sessions.list", {});
} catch (err) {
  if (err instanceof GatewayRequestError) {
    console.log(err.gatewayCode); // vd: "NOT_FOUND"
    console.log(err.message);
  }
}
```

---

## `use-gateway.ts` — React Hooks

### `useGateway(options?)`

Hook chính để kết nối gateway trong React component.

```ts
const { state, error, client, gatewayUrl, request, reconnect } = useGateway({
  url?: string,       // Nếu không truyền → lấy từ localStorage settings
  token?: string,     // Nếu không truyền → lấy từ localStorage settings
  password?: string,
  autoConnect?: boolean, // Mặc định: true
});
```

#### Return value

| Field        | Kiểu                                                       | Mô tả                             |
| ------------ | ---------------------------------------------------------- | --------------------------------- |
| `state`      | `"connecting" \| "connected" \| "disconnected" \| "error"` | Trạng thái kết nối                |
| `error`      | `string \| null`                                           | Thông báo lỗi (nếu state="error") |
| `client`     | `GatewayClient \| null`                                    | Instance client trực tiếp         |
| `gatewayUrl` | `string`                                                   | URL đang kết nối                  |
| `request`    | `<T>(method, params?) => Promise<T>`                       | Gửi request                       |
| `reconnect`  | `() => void`                                               | Kết nối lại thủ công              |

#### Cách dùng điển hình trong page

```tsx
"use client";

export default function MyPage() {
  const { state, request } = useGateway();

  const loadData = useCallback(async () => {
    if (state !== "connected") return;
    const res = await request<MyType>("some.method", { params });
    setData(res);
  }, [state, request]);

  useEffect(() => {
    if (state === "connected") loadData();
  }, [state, loadData]);

  const isDisabled = state !== "connected";
  // ...
}
```

### `useGatewayEvents(client, onEvent)`

Hook để subscribe gateway events.

```ts
useGatewayEvents(client, (evt: GatewayEventFrame) => {
  if (evt.event === "session.updated") {
    // handle event
  }
});
```

> **Lưu ý**: Implementation hiện tại đang simplified, cần `GatewayClient` hỗ trợ event subscriptions.

---

## `use-settings.ts` — Settings Hook

```ts
const { settings, updateSettings, isLoaded } = useSettings();
```

#### `UiSettings` type (từ `storage.ts`)

```ts
type UiSettings = {
  gatewayUrl: string; // URL WebSocket
  token: string; // Auth token
  sessionKey: string; // Key session đang dùng
  lastActiveSessionKey: string;
  theme: "light" | "dark" | "system";
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // 0.4–0.7
  navCollapsed: boolean;
  navGroupsCollapsed: Record<string, boolean>;
};
```

**Default values** (khi chưa có settings):

- `gatewayUrl`: Auto-detect từ `window.location` (`ws://` hoặc `wss://`)
- `sessionKey`: `"main"`
- `theme`: `"system"`
- `chatShowThinking`: `true`
- `splitRatio`: `0.6`

**SSR-safe**: Dùng `useSyncExternalStore` → server trả về `null`, client load từ `localStorage`.

---

## `storage.ts` — LocalStorage Persistence

```ts
const KEY = "openclaw.control.settings.v1";

loadSettings(): UiSettings    // đọc + merge với defaults
saveSettings(next: UiSettings): void   // stringify và lưu
```

> Có validation từng field khi load để tránh crash khi dữ liệu localStorage bị corrupt.

---

## `format.ts` — Format Utilities

| Function                  | Signature                                     | Mô tả                                     |
| ------------------------- | --------------------------------------------- | ----------------------------------------- |
| `formatRelativeTimestamp` | `(ms: number) => string`                      | "5 minutes ago", "in 2 hours", "just now" |
| `formatDurationHuman`     | `(ms: number) => string`                      | "1.5s", "2m 30s", "1h 15m"                |
| `formatMs`                | `(ms?: number\|null) => string`               | `toLocaleString()` hoặc "n/a"             |
| `formatList`              | `(values?: string[]) => string`               | "a, b, c" hoặc "none"                     |
| `clampText`               | `(value: string, max=120) => string`          | Cắt với "…"                               |
| `truncateText`            | `(value, max) => { text, truncated, total }`  | Cắt với metadata                          |
| `toNumber`                | `(value: string, fallback: number) => number` | Parse string → number                     |
| `parseList`               | `(input: string) => string[]`                 | Split bằng dấu phẩy hoặc newline          |
| `formatSessionTokens`     | `(row: GatewaySessionRow) => string`          | "1234 / 5678" hoặc "n/a"                  |
| `formatNextRun`           | `(ms?: number\|null) => string`               | "Mon, 2/28 10:30 AM (in 5 minutes)"       |

---

## `device-auth.ts` — Device Auth Token

Quản lý device auth token được cấp từ server sau lần auth đầu tiên.

```ts
// Lưu token sau khi nhận từ gateway
storeDeviceAuthToken({ deviceId, role, token, scopes });

// Load token để dùng cho lần kết nối tiếp
loadDeviceAuthToken({ deviceId, role }): { token, scopes, issuedAt } | null

// Xóa khi auth fail (để force re-auth)
clearDeviceAuthToken({ deviceId, role });

// Tạo payload để ký
buildDeviceAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce })
```

---

## `device-identity.ts` — Ed25519 Device Identity

Mỗi browser instance có unique identity với Ed25519 key pair, lưu trong `localStorage`.

```ts
// Load hoặc tạo mới identity
const identity = await loadOrCreateDeviceIdentity();
// { deviceId: string, publicKey: string, privateKey: CryptoKey }

// Ký payload để xác thực với server
const signature = await signDevicePayload(privateKey, payloadString);
```

**Dùng** `@noble/ed25519` library (version 3.0.0).

> Chỉ khả dụng trong **secure context** (HTTPS hoặc localhost).

---

## `cn.ts` — ClassNames Utility

```ts
import { cn } from "@/lib/cn";

// Kết hợp class names (conditional classes)
cn("base-class", condition && "conditional-class", "another-class");
```

> Wrapper đơn giản, tương tự `clsx`.
