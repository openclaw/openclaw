---
summary: "Dịch vụ điều khiển trình duyệt tích hợp + các lệnh hành động"
read_when:
  - Thêm tự động hóa trình duyệt do tác tử điều khiển
  - Gỡ lỗi vì sao openclaw can thiệp vào Chrome của bạn
  - Triển khai cài đặt trình duyệt + vòng đời trong ứng dụng macOS
title: "Trình duyệt (do OpenClaw quản lý)"
---

# Trình duyệt (do openclaw quản lý)

OpenClaw can run a **dedicated Chrome/Brave/Edge/Chromium profile** that the agent controls.
35. Nó được cô lập khỏi trình duyệt cá nhân của bạn và được quản lý thông qua một dịch vụ điều khiển cục bộ nhỏ bên trong Gateway (chỉ loopback).

Góc nhìn cho người mới:

- Hãy xem nó như một **trình duyệt riêng, chỉ dành cho tác tử**.
- Profile `openclaw` **không** chạm vào profile trình duyệt cá nhân của bạn.
- Tác tử có thể **mở tab, đọc trang, nhấp, và gõ** trong một làn an toàn.
- Profile `chrome` mặc định sử dụng **trình duyệt Chromium mặc định của hệ thống** thông qua
  relay extension; chuyển sang `openclaw` để dùng trình duyệt được quản lý và cách ly.

## Những gì bạn nhận được

- Một profile trình duyệt riêng tên **openclaw** (mặc định có điểm nhấn màu cam).
- Điều khiển tab mang tính quyết định (liệt kê/mở/tập trung/đóng).
- Hành động của tác tử (nhấp/gõ/kéo/chọn), snapshot, ảnh chụp màn hình, PDF.
- Hỗ trợ đa profile tùy chọn (`openclaw`, `work`, `remote`, ...).

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

## Khởi động nhanh

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Nếu bạn gặp “Browser disabled”, hãy bật nó trong cấu hình (xem bên dưới) và khởi động lại
Gateway.

## Profile: `openclaw` vs `chrome`

- `openclaw`: trình duyệt được quản lý, cách ly (không cần extension).
- `chrome`: relay extension tới **trình duyệt hệ thống** của bạn (yêu cầu extension OpenClaw
  được gắn vào một tab).

Đặt `browser.defaultProfile: "openclaw"` nếu bạn muốn chế độ managed làm mặc định.

## Cấu hình

Cài đặt trình duyệt nằm trong `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Ghi chú:

- The browser control service binds to loopback on a port derived from `gateway.port`
  (default: `18791`, which is gateway + 2). The relay uses the next port (`18792`).
- Nếu bạn ghi đè cổng Gateway (`gateway.port` hoặc `OPENCLAW_GATEWAY_PORT`),
  các cổng trình duyệt suy ra sẽ dịch chuyển để giữ cùng một “họ”.
- `cdpUrl` mặc định là cổng relay khi không được đặt.
- `remoteCdpTimeoutMs` áp dụng cho kiểm tra khả năng truy cập CDP từ xa (không loopback).
- `remoteCdpHandshakeTimeoutMs` áp dụng cho kiểm tra khả năng truy cập WebSocket CDP từ xa.
- `attachOnly: true` nghĩa là “không bao giờ khởi chạy trình duyệt cục bộ; chỉ gắn nếu nó đã chạy.”
- `color` + `color` theo từng profile nhuộm màu UI trình duyệt để bạn biết profile nào đang hoạt động.
- Default profile is `chrome` (extension relay). 36. Dùng `defaultProfile: "openclaw"` cho trình duyệt được quản lý.
- Thứ tự tự phát hiện: trình duyệt mặc định hệ thống nếu dựa trên Chromium; nếu không thì Chrome → Brave → Edge → Chromium → Chrome Canary.
- Các profile `openclaw` cục bộ tự gán `cdpPort`/`cdpUrl` — chỉ đặt các giá trị đó cho CDP từ xa.

## Dùng Brave (hoặc trình duyệt dựa trên Chromium khác)

If your **system default** browser is Chromium-based (Chrome/Brave/Edge/etc),
OpenClaw uses it automatically. Set `browser.executablePath` to override
auto-detection:

Ví dụ CLI:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Điều khiển cục bộ vs từ xa

- **Điều khiển cục bộ (mặc định):** Gateway khởi động dịch vụ điều khiển loopback và có thể mở trình duyệt cục bộ.
- **Điều khiển từ xa (node host):** chạy một node host trên máy có trình duyệt; Gateway proxy các hành động trình duyệt tới đó.
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chromium-based browser. 37. Trong trường hợp này, OpenClaw sẽ không khởi chạy trình duyệt cục bộ.

URL CDP từ xa có thể bao gồm xác thực:

- Token qua query (ví dụ: `https://provider.example?token=<token>`)
- HTTP Basic auth (ví dụ: `https://user:pass@provider.example`)

OpenClaw preserves the auth when calling `/json/*` endpoints and when connecting
to the CDP WebSocket. Prefer environment variables or secrets managers for
tokens instead of committing them to config files.

## Node browser proxy (mặc định zero-config)

If you run a **node host** on the machine that has your browser, OpenClaw can
auto-route browser tool calls to that node without any extra browser config.
38. Đây là đường dẫn mặc định cho các gateway từ xa.

Ghi chú:

- Node host phơi bày máy chủ điều khiển trình duyệt cục bộ của nó thông qua một **proxy command**.
- Profile lấy từ cấu hình `browser.profiles` của chính node (giống như cục bộ).
- Tắt nếu bạn không muốn:
  - Trên node: `nodeHost.browserProxy.enabled=false`
  - Trên gateway: `gateway.nodes.browser.mode="off"`

## Browserless (CDP từ xa được lưu trữ)

[Browserless](https://browserless.io) is a hosted Chromium service that exposes
CDP endpoints over HTTPS. You can point a OpenClaw browser profile at a
Browserless region endpoint and authenticate with your API key.

Ví dụ:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Ghi chú:

- Thay `<BROWSERLESS_API_KEY>` bằng token Browserless thực của bạn.
- Chọn endpoint khu vực phù hợp với tài khoản Browserless của bạn (xem tài liệu của họ).

## Bảo mật

Ý chính:

- Điều khiển trình duyệt chỉ qua loopback; truy cập đi qua xác thực của Gateway hoặc ghép cặp node.
- Giữ Gateway và mọi node host trong mạng riêng (Tailscale); tránh phơi bày công khai.
- Xem URL/token CDP từ xa như bí mật; ưu tiên biến môi trường hoặc secrets manager.

Mẹo cho CDP từ xa:

- Ưu tiên endpoint HTTPS và token ngắn hạn khi có thể.
- Tránh nhúng token dài hạn trực tiếp trong file cấu hình.

## Profile (đa trình duyệt)

OpenClaw supports multiple named profiles (routing configs). Profiles can be:

- **openclaw-managed**: một instance trình duyệt dựa trên Chromium chuyên dụng với thư mục dữ liệu người dùng + cổng CDP riêng
- **remote**: một URL CDP tường minh (trình duyệt dựa trên Chromium chạy ở nơi khác)
- **extension relay**: các tab Chrome hiện có của bạn thông qua relay cục bộ + Chrome extension

Mặc định:

- Profile `openclaw` được tự động tạo nếu thiếu.
- Profile `chrome` là built-in cho relay Chrome extension (mặc định trỏ tới `http://127.0.0.1:18792`).
- Các cổng CDP cục bộ được cấp phát từ **18800–18899** theo mặc định.
- Xóa một profile sẽ chuyển thư mục dữ liệu cục bộ của nó vào Thùng rác.

Tất cả các endpoint điều khiển chấp nhận `?profile=<name>`; CLI dùng `--browser-profile`.

## Chrome extension relay (dùng Chrome hiện có của bạn)

OpenClaw cũng có thể điều khiển **các tab Chrome hiện có của bạn** (không cần một instance Chrome “openclaw” riêng)
thông qua relay CDP cục bộ + một Chrome extension.

Hướng dẫn đầy đủ: [Chrome extension](/tools/chrome-extension)

Luồng hoạt động:

- Gateway chạy cục bộ (cùng máy) hoặc một node host chạy trên máy có trình duyệt.
- Một **máy chủ relay** cục bộ lắng nghe tại một loopback `cdpUrl` (mặc định: `http://127.0.0.1:18792`).
- Bạn nhấp biểu tượng extension **OpenClaw Browser Relay** trên một tab để gắn (nó không tự động gắn).
- Tác tử điều khiển tab đó qua công cụ `browser` thông thường, bằng cách chọn đúng profile.

Nếu Gateway chạy ở nơi khác, hãy chạy một node host trên máy có trình duyệt để Gateway có thể proxy các hành động trình duyệt.

### Phiên sandboxed

If the agent session is sandboxed, the `browser` tool may default to `target="sandbox"` (sandbox browser).
Chrome extension relay takeover requires host browser control, so either:

- chạy phiên không sandboxed, hoặc
- đặt `agents.defaults.sandbox.browser.allowHostControl: true` và dùng `target="host"` khi gọi công cụ.

### Thiết lập

1. Tải extension (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → bật “Developer mode”
- “Load unpacked” → chọn thư mục được in bởi `openclaw browser extension path`
- Ghim extension, sau đó nhấp vào nó trên tab bạn muốn điều khiển (huy hiệu hiển thị `ON`).

2. Sử dụng:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Công cụ tác tử: `browser` với `profile="chrome"`

Tùy chọn: nếu bạn muốn tên khác hoặc cổng relay khác, hãy tạo profile riêng:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Ghi chú:

- Chế độ này dựa vào Playwright-on-CDP cho hầu hết thao tác (ảnh chụp/snapshot/hành động).
- Gỡ gắn bằng cách nhấp lại biểu tượng extension.

## Cam kết cách ly

- **Thư mục dữ liệu người dùng chuyên dụng**: không bao giờ chạm vào profile trình duyệt cá nhân của bạn.
- **Cổng chuyên dụng**: tránh `9222` để ngăn xung đột với quy trình dev.
- **Điều khiển tab mang tính quyết định**: nhắm tab theo `targetId`, không phải “tab cuối”.

## Lựa chọn trình duyệt

Khi khởi chạy cục bộ, OpenClaw chọn cái khả dụng đầu tiên:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Bạn có thể ghi đè bằng `browser.executablePath`.

Nền tảng:

- macOS: kiểm tra `/Applications` và `~/Applications`.
- Linux: tìm `google-chrome`, `brave`, `microsoft-edge`, `chromium`, v.v.
- Windows: kiểm tra các vị trí cài đặt phổ biến.

## Control API (tùy chọn)

Chỉ cho tích hợp cục bộ, Gateway phơi bày một HTTP API loopback nhỏ:

- Trạng thái/bắt đầu/dừng: `GET /`, `POST /start`, `POST /stop`
- Tab: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/ảnh chụp: `GET /snapshot`, `POST /screenshot`
- Hành động: `POST /navigate`, `POST /act`
- Hook: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Tải xuống: `POST /download`, `POST /wait/download`
- Gỡ lỗi: `GET /console`, `POST /pdf`
- Gỡ lỗi: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Mạng: `POST /response/body`
- Trạng thái: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Trạng thái: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Cài đặt: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Tất cả các endpoint chấp nhận `?profile=<name>`.

### Yêu cầu Playwright

Some features (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) require
Playwright. If Playwright isn’t installed, those endpoints return a clear 501
error. ARIA snapshots and basic screenshots still work for openclaw-managed Chrome.
For the Chrome extension relay driver, ARIA snapshots and screenshots require Playwright.

Nếu bạn thấy `Playwright is not available in this gateway build`, hãy cài gói
Playwright đầy đủ (không phải `playwright-core`) và khởi động lại gateway, hoặc cài lại
OpenClaw với hỗ trợ trình duyệt.

#### Cài Playwright cho Docker

1. Nếu Gateway của bạn chạy trong Docker, tránh dùng `npx playwright` (xung đột ghi đè npm).
2. Thay vào đó, hãy dùng CLI được đóng gói sẵn:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

3. Để lưu trữ các bản tải xuống của trình duyệt, hãy đặt `PLAYWRIGHT_BROWSERS_PATH` (ví dụ,
   `/home/node/.cache/ms-playwright`) và đảm bảo `/home/node` được lưu trữ bền vững thông qua
   `OPENCLAW_HOME_VOLUME` hoặc một bind mount. 4. Xem [Docker](/install/docker).

## Cách hoạt động (nội bộ)

Luồng tổng quát:

- Một **máy chủ điều khiển** nhỏ nhận các yêu cầu HTTP.
- Nó kết nối tới các trình duyệt dựa trên Chromium (Chrome/Brave/Edge/Chromium) qua **CDP**.
- Với các hành động nâng cao (nhấp/gõ/snapshot/PDF), nó dùng **Playwright** phía trên CDP.
- Khi thiếu Playwright, chỉ các thao tác không dùng Playwright khả dụng.

Thiết kế này giữ cho tác tử ở trên một giao diện ổn định, mang tính quyết định, đồng thời cho phép
bạn hoán đổi trình duyệt và profile cục bộ/từ xa.

## Tham chiếu nhanh CLI

All commands accept `--browser-profile <name>` to target a specific profile.
39. Tất cả các lệnh cũng chấp nhận `--json` để xuất kết quả dạng máy đọc được (payload ổn định).

Cơ bản:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Kiểm tra:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Hành động:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

Trạng thái:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Ghi chú:

- `upload` và `dialog` là các lệnh **arming**; chạy chúng trước thao tác click/press
  kích hoạt chooser/dialog.
- `upload` cũng có thể đặt trực tiếp input file thông qua `--input-ref` hoặc `--element`.
- `snapshot`:
  - `--format ai` (mặc định khi Playwright được cài): trả về AI snapshot với ref số (`aria-ref="<n>"`).
  - `--format aria`: trả về cây accessibility (không có ref; chỉ để kiểm tra).
  - `--efficient` (hoặc `--mode efficient`): preset role snapshot gọn (tương tác + gọn + độ sâu + maxChars thấp hơn).
  - Mặc định cấu hình (chỉ tool/CLI): đặt `browser.snapshotDefaults.mode: "efficient"` để dùng snapshot hiệu quả khi caller không truyền mode (xem [Cấu hình Gateway](/gateway/configuration#browser-openclaw-managed-browser)).
  - Tùy chọn role snapshot (`--interactive`, `--compact`, `--depth`, `--selector`) ép snapshot theo role với ref như `ref=e12`.
  - `--frame "<iframe selector>"` giới hạn role snapshot trong một iframe (kết hợp với role ref như `e12`).
  - `--interactive` xuất danh sách phẳng, dễ chọn các phần tử tương tác (tốt nhất để điều khiển hành động).
  - `--labels` thêm ảnh chụp chỉ viewport với nhãn ref chồng lên (in `MEDIA:<path>`).
- 40. `click`/`type`/v.v. yêu cầu một `ref` từ `snapshot` (có thể là số `12` hoặc role ref `e12`).
  41. Bộ chọn CSS cố ý không được hỗ trợ cho các hành động.

## Snapshot và ref

OpenClaw hỗ trợ hai kiểu “snapshot”:

- **AI snapshot (ref số)**: `openclaw browser snapshot` (mặc định; `--format ai`)
  - Đầu ra: snapshot dạng văn bản bao gồm ref số.
  - Hành động: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Nội bộ, ref được phân giải qua `aria-ref` của Playwright.

- **Role snapshot (role ref như `e12`)**: `openclaw browser snapshot --interactive` (hoặc `--compact`, `--depth`, `--selector`, `--frame`)
  - Đầu ra: danh sách/cây dựa trên role với `[ref=e12]` (và tùy chọn `[nth=1]`).
  - Hành động: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Nội bộ, ref được phân giải qua `getByRole(...)` (kèm `nth()` cho trùng lặp).
  - Thêm `--labels` để kèm ảnh chụp viewport với nhãn `e12` chồng lên.

Hành vi ref:

- Ref **không ổn định qua các lần điều hướng**; nếu có lỗi, hãy chạy lại `snapshot` và dùng ref mới.
- Nếu role snapshot được chụp với `--frame`, role ref sẽ bị giới hạn trong iframe đó cho tới role snapshot kế tiếp.

## Power-up chờ đợi

Bạn có thể chờ nhiều hơn chỉ thời gian/văn bản:

- Chờ URL (hỗ trợ glob của Playwright):
  - `openclaw browser wait --url "**/dash"`
- Chờ trạng thái tải:
  - `openclaw browser wait --load networkidle`
- Chờ một predicate JS:
  - `openclaw browser wait --fn "window.ready===true"`
- Chờ một selector trở nên hiển thị:
  - `openclaw browser wait "#main"`

Có thể kết hợp:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Quy trình gỡ lỗi

Khi một hành động thất bại (ví dụ: “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. Dùng `click <ref>` / `type <ref>` (ưu tiên role ref ở chế độ tương tác)
3. Nếu vẫn thất bại: `openclaw browser highlight <ref>` để xem Playwright đang nhắm tới đâu
4. Nếu trang hoạt động lạ:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Gỡ lỗi sâu: ghi lại trace:
   - `openclaw browser trace start`
   - tái hiện sự cố
   - `openclaw browser trace stop` (in `TRACE:<path>`)

## Đầu ra JSON

`--json` dành cho scripting và công cụ có cấu trúc.

Ví dụ:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Role snapshot ở JSON bao gồm `refs` cùng một khối `stats` nhỏ (dòng/ký tự/ref/tương tác) để công cụ có thể suy luận về kích thước và mật độ payload.

## Các nút trạng thái và môi trường

Hữu ích cho các quy trình “làm cho trang hoạt động như X”:

- Cookie: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Header: `set headers --json '{"X-Debug":"1"}'` (hoặc `--clear`)
- HTTP basic auth: `set credentials user pass` (hoặc `--clear`)
- Định vị địa lý: `set geo <lat> <lon> --origin "https://example.com"` (hoặc `--clear`)
- Media: `set media dark|light|no-preference|none`
- Múi giờ / locale: `set timezone ...`, `set locale ...`
- Thiết bị / viewport:
  - `set device "iPhone 14"` (preset thiết bị của Playwright)
  - `set viewport 1280 720`

## Bảo mật & quyền riêng tư

- Profile trình duyệt openclaw có thể chứa các phiên đã đăng nhập; hãy xem nó là nhạy cảm.
- `browser act kind=evaluate` / `openclaw browser evaluate` and `wait --fn`
  execute arbitrary JavaScript in the page context. 41. Prompt injection có thể điều hướng điều này. 42. Vô hiệu hóa bằng `browser.evaluateEnabled=false` nếu bạn không cần.
- Với ghi chú đăng nhập và chống bot (X/Twitter, v.v.), xem [Đăng nhập trình duyệt + đăng bài X/Twitter](/tools/browser-login).
- Giữ Gateway/node host ở chế độ riêng tư (chỉ loopback hoặc tailnet).
- Endpoint CDP từ xa rất mạnh; hãy tunnel và bảo vệ chúng.

## Xử lý sự cố

Với các vấn đề riêng cho Linux (đặc biệt là Chromium snap), xem
[Xử lý sự cố trình duyệt](/tools/browser-linux-troubleshooting).

## Công cụ tác tử + cách điều khiển hoạt động

Tác tử có **một công cụ** cho tự động hóa trình duyệt:

- `browser` — trạng thái/bắt đầu/dừng/tab/mở/tập trung/đóng/snapshot/ảnh chụp/điều hướng/hành động

Cách ánh xạ:

- `browser snapshot` trả về cây UI ổn định (AI hoặc ARIA).
- `browser act` dùng các ID `ref` từ snapshot để nhấp/gõ/kéo/chọn.
- `browser screenshot` chụp pixel (toàn trang hoặc phần tử).
- `browser` chấp nhận:
  - `profile` để chọn profile trình duyệt có tên (openclaw, chrome, hoặc CDP từ xa).
  - `target` (`sandbox` | `host` | `node`) để chọn nơi trình duyệt tồn tại.
  - Trong phiên sandboxed, `target: "host"` yêu cầu `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Nếu bỏ `target`: phiên sandboxed mặc định `sandbox`, phiên không sandbox mặc định `host`.
  - Nếu có node có khả năng trình duyệt được kết nối, công cụ có thể tự động định tuyến tới nó trừ khi bạn ghim `target="host"` hoặc `target="node"`.

Điều này giúp tác tử mang tính quyết định và tránh các selector mong manh.
