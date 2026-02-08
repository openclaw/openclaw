---
summary: "Thiết lập và hướng dẫn ban đầu tùy chọn dựa trên Docker cho OpenClaw"
read_when:
  - Bạn muốn một gateway chạy trong container thay vì cài đặt cục bộ
  - Bạn đang kiểm tra luồng Docker
title: "Docker"
x-i18n:
  source_path: install/docker.md
  source_hash: fb8c7004b18753a2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:44Z
---

# Docker (tùy chọn)

Docker là **tùy chọn**. Chỉ dùng khi bạn muốn một gateway chạy trong container hoặc để kiểm tra luồng Docker.

## Docker có phù hợp với tôi không?

- **Có**: bạn muốn một môi trường gateway tách biệt, dùng xong bỏ, hoặc chạy OpenClaw trên máy chủ không có cài đặt cục bộ.
- **Không**: bạn chạy trên máy của mình và chỉ muốn vòng lặp phát triển nhanh nhất. Hãy dùng luồng cài đặt thông thường.
- **Lưu ý sandboxing**: sandboxing cho tác tử cũng dùng Docker, nhưng **không** yêu cầu toàn bộ gateway phải chạy trong Docker. Xem [Sandboxing](/gateway/sandboxing).

Hướng dẫn này bao gồm:

- Gateway chạy trong container (toàn bộ OpenClaw trong Docker)
- Sandbox Tác tử theo phiên (gateway trên host + công cụ tác tử được cô lập bằng Docker)

Chi tiết sandboxing: [Sandboxing](/gateway/sandboxing)

## Yêu cầu

- Docker Desktop (hoặc Docker Engine) + Docker Compose v2
- Đủ dung lượng đĩa cho image + log

## Gateway chạy trong container (Docker Compose)

### Khởi động nhanh (khuyến nghị)

Từ thư mục gốc của repo:

```bash
./docker-setup.sh
```

Script này sẽ:

- build image gateway
- chạy trình hướng dẫn onboarding
- in ra các gợi ý thiết lập nhà cung cấp (tùy chọn)
- khởi động gateway qua Docker Compose
- tạo token gateway và ghi vào `.env`

Biến môi trường tùy chọn:

- `OPENCLAW_DOCKER_APT_PACKAGES` — cài thêm các gói apt trong quá trình build
- `OPENCLAW_EXTRA_MOUNTS` — thêm các bind mount từ host
- `OPENCLAW_HOME_VOLUME` — lưu `/home/node` trong một volume có tên

Sau khi hoàn tất:

- Mở `http://127.0.0.1:18789/` trong trình duyệt.
- Dán token vào Control UI (Settings → token).
- Cần lại URL? Chạy `docker compose run --rm openclaw-cli dashboard --no-open`.

Nó ghi cấu hình/workspace trên host:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Chạy trên VPS? Xem [Hetzner (Docker VPS)](/install/hetzner).

### Luồng thủ công (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Lưu ý: chạy `docker compose ...` từ thư mục gốc của repo. Nếu bạn bật
`OPENCLAW_EXTRA_MOUNTS` hoặc `OPENCLAW_HOME_VOLUME`, script thiết lập sẽ ghi
`docker-compose.extra.yml`; hãy đưa nó vào khi chạy Compose ở nơi khác:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Token Control UI + ghép cặp (Docker)

Nếu bạn thấy “unauthorized” hoặc “disconnected (1008): pairing required”, hãy lấy
liên kết dashboard mới và phê duyệt thiết bị trình duyệt:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Chi tiết thêm: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Mount bổ sung (tùy chọn)

Nếu bạn muốn mount thêm các thư mục từ host vào container, hãy đặt
`OPENCLAW_EXTRA_MOUNTS` trước khi chạy `docker-setup.sh`. Biến này nhận danh sách
bind mount Docker, phân tách bằng dấu phẩy, và áp dụng cho cả
`openclaw-gateway` và `openclaw-cli` bằng cách tạo `docker-compose.extra.yml`.

Ví dụ:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Ghi chú:

- Đường dẫn phải được chia sẻ với Docker Desktop trên macOS/Windows.
- Nếu bạn chỉnh sửa `OPENCLAW_EXTRA_MOUNTS`, hãy chạy lại `docker-setup.sh` để tạo lại
  file compose bổ sung.
- `docker-compose.extra.yml` được tạo tự động. Đừng chỉnh sửa thủ công.

### Lưu toàn bộ home của container (tùy chọn)

Nếu bạn muốn `/home/node` được giữ lại qua các lần tạo lại container, hãy đặt
một volume có tên qua `OPENCLAW_HOME_VOLUME`. Việc này tạo một Docker volume và mount tại
`/home/node`, đồng thời vẫn giữ các bind mount cấu hình/workspace tiêu chuẩn.
Hãy dùng volume có tên ở đây (không dùng bind path); với bind mount, dùng
`OPENCLAW_EXTRA_MOUNTS`.

Ví dụ:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Bạn có thể kết hợp với mount bổ sung:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Ghi chú:

- Nếu bạn thay đổi `OPENCLAW_HOME_VOLUME`, hãy chạy lại `docker-setup.sh` để tạo lại
  file compose bổ sung.
- Volume có tên sẽ tồn tại cho đến khi bị xóa bằng `docker volume rm <name>`.

### Cài thêm gói apt (tùy chọn)

Nếu bạn cần các gói hệ thống bên trong image (ví dụ: công cụ build hoặc thư viện
media), hãy đặt `OPENCLAW_DOCKER_APT_PACKAGES` trước khi chạy `docker-setup.sh`.
Các gói này được cài trong quá trình build image, nên vẫn tồn tại ngay cả khi
container bị xóa.

Ví dụ:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Ghi chú:

- Nhận danh sách tên gói apt, phân tách bằng dấu cách.
- Nếu bạn thay đổi `OPENCLAW_DOCKER_APT_PACKAGES`, hãy chạy lại `docker-setup.sh` để build lại
  image.

### Container đầy đủ tính năng cho người dùng nâng cao (tùy chọn)

Image Docker mặc định ưu tiên **bảo mật** và chạy dưới người dùng không phải root
`node`. Điều này giúp giảm bề mặt tấn công, nhưng đồng nghĩa:

- không cài gói hệ thống lúc runtime
- không có Homebrew mặc định
- không kèm trình duyệt Chromium/Playwright

Nếu bạn muốn container đầy đủ tính năng hơn, hãy dùng các tùy chọn opt-in sau:

1. **Lưu `/home/node`** để các bản tải trình duyệt và cache công cụ được giữ lại:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Đóng gói phụ thuộc hệ thống vào image** (lặp lại được + bền vững):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Cài trình duyệt Playwright không cần `npx`** (tránh xung đột override npm):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Nếu bạn cần Playwright cài phụ thuộc hệ thống, hãy build lại image với
`OPENCLAW_DOCKER_APT_PACKAGES` thay vì dùng `--with-deps` lúc runtime.

4. **Lưu các bản tải trình duyệt Playwright**:

- Đặt `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` trong
  `docker-compose.yml`.
- Đảm bảo `/home/node` được giữ lại qua `OPENCLAW_HOME_VOLUME`, hoặc mount
  `/home/node/.cache/ms-playwright` qua `OPENCLAW_EXTRA_MOUNTS`.

### Quyền + EACCES

Image chạy dưới `node` (uid 1000). Nếu bạn gặp lỗi quyền truy cập trên
`/home/node/.openclaw`, hãy đảm bảo các bind mount trên host thuộc sở hữu uid 1000.

Ví dụ (host Linux):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Nếu bạn chọn chạy dưới root cho tiện lợi, bạn chấp nhận đánh đổi về bảo mật.

### Build lại nhanh hơn (khuyến nghị)

Để tăng tốc build lại, hãy sắp xếp Dockerfile sao cho các layer phụ thuộc được cache.
Điều này tránh việc chạy lại `pnpm install` trừ khi lockfile thay đổi:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Thiết lập kênh (tùy chọn)

Dùng container CLI để cấu hình kênh, rồi khởi động lại gateway nếu cần.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Tài liệu: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (Docker không giao diện)

Nếu bạn chọn OpenAI Codex OAuth trong trình hướng dẫn, nó sẽ mở một URL trình duyệt
và cố gắng nhận callback tại `http://127.0.0.1:1455/auth/callback`. Trong Docker hoặc các thiết lập
không giao diện, callback này có thể hiện lỗi trình duyệt. Hãy sao chép toàn bộ URL
redirect mà bạn truy cập được và dán lại vào trình hướng dẫn để hoàn tất xác thực.

### Kiểm tra sức khỏe

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### Kiểm thử E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Kiểm thử import QR smoke test (Docker)

```bash
pnpm test:docker:qr
```

### Ghi chú

- Gateway bind mặc định là `lan` cho việc dùng trong container.
- CMD của Dockerfile dùng `--allow-unconfigured`; cấu hình được mount với `gateway.mode` chứ không phải `local` vẫn sẽ khởi động. Ghi đè CMD để bắt buộc kiểm tra.
- Container gateway là nguồn chân lý cho các phiên (`~/.openclaw/agents/<agentId>/sessions/`).

## Sandbox Tác tử (gateway trên host + công cụ Docker)

Đào sâu: [Sandboxing](/gateway/sandboxing)

### Nó làm gì

Khi bật `agents.defaults.sandbox`, **các phiên không phải chính** sẽ chạy công cụ bên trong
container Docker. Gateway vẫn chạy trên host, nhưng việc thực thi công cụ được cô lập:

- phạm vi: `"agent"` theo mặc định (một container + workspace cho mỗi tác tử)
- phạm vi: `"session"` để cô lập theo từng phiên
- thư mục workspace theo phạm vi được mount tại `/workspace`
- quyền truy cập workspace tác tử tùy chọn (`agents.defaults.sandbox.workspaceAccess`)
- chính sách cho phép/từ chối công cụ (từ chối được ưu tiên)
- media đầu vào được sao chép vào workspace sandbox đang hoạt động (`media/inbound/*`) để công cụ có thể đọc (với `workspaceAccess: "rw"`, nội dung này nằm trong workspace tác tử)

Cảnh báo: `scope: "shared"` vô hiệu hóa cô lập giữa các phiên. Tất cả phiên dùng chung
một container và một workspace.

### Hồ sơ sandbox theo từng tác tử (đa tác tử)

Nếu bạn dùng định tuyến đa tác tử, mỗi tác tử có thể ghi đè cài đặt sandbox + công cụ:
`agents.list[].sandbox` và `agents.list[].tools` (cộng thêm `agents.list[].tools.sandbox.tools`). Điều này cho phép
chạy các mức truy cập khác nhau trong cùng một gateway:

- Toàn quyền (tác tử cá nhân)
- Công cụ chỉ đọc + workspace chỉ đọc (tác tử gia đình/công việc)
- Không có công cụ filesystem/shell (tác tử công khai)

Xem [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) để biết ví dụ,
thứ tự ưu tiên và xử lý sự cố.

### Hành vi mặc định

- Image: `openclaw-sandbox:bookworm-slim`
- Mỗi tác tử một container
- Quyền truy cập workspace tác tử: `workspaceAccess: "none"` (mặc định) dùng `~/.openclaw/sandboxes`
  - `"ro"` giữ workspace sandbox tại `/workspace` và mount workspace tác tử ở chế độ chỉ đọc tại `/agent` (vô hiệu `write`/`edit`/`apply_patch`)
  - `"rw"` mount workspace tác tử đọc/ghi tại `/workspace`
- Tự động dọn dẹp: nhàn rỗi > 24h HOẶC tuổi > 7 ngày
- Mạng: `none` theo mặc định (chỉ bật khi bạn cần egress)
- Cho phép mặc định: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Từ chối mặc định: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Bật sandboxing

Nếu bạn dự định cài gói trong `setupCommand`, lưu ý:

- `docker.network` mặc định là `"none"` (không egress).
- `readOnlyRoot: true` chặn việc cài gói.
- `user` phải là root cho `apt-get` (bỏ `user` hoặc đặt `user: "0:0"`).
  OpenClaw tự động tạo lại container khi `setupCommand` (hoặc cấu hình docker) thay đổi
  trừ khi container **vừa được dùng** (trong ~5 phút). Các container đang nóng
  sẽ ghi cảnh báo kèm lệnh `openclaw sandbox recreate ...` chính xác.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Các nút tăng cường bảo mật nằm dưới `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Đa tác tử: ghi đè `agents.defaults.sandbox.{docker,browser,prune}.*` theo từng tác tử qua `agents.list[].sandbox.{docker,browser,prune}.*`
(bị bỏ qua khi `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` là `"shared"`).

### Build image sandbox mặc định

```bash
scripts/sandbox-setup.sh
```

Lệnh này build `openclaw-sandbox:bookworm-slim` dùng `Dockerfile.sandbox`.

### Image sandbox dùng chung (tùy chọn)

Nếu bạn muốn một image sandbox có sẵn công cụ build phổ biến (Node, Go, Rust, v.v.), hãy build image dùng chung:

```bash
scripts/sandbox-common-setup.sh
```

Lệnh này build `openclaw-sandbox-common:bookworm-slim`. Để sử dụng:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Image sandbox cho trình duyệt

Để chạy công cụ trình duyệt trong sandbox, hãy build image trình duyệt:

```bash
scripts/sandbox-browser-setup.sh
```

Lệnh này build `openclaw-sandbox-browser:bookworm-slim` dùng
`Dockerfile.sandbox-browser`. Container chạy Chromium với CDP được bật và
một trình quan sát noVNC tùy chọn (có giao diện qua Xvfb).

Ghi chú:

- Có giao diện (Xvfb) giúp giảm bị chặn bot so với headless.
- Headless vẫn có thể dùng bằng cách đặt `agents.defaults.sandbox.browser.headless=true`.
- Không cần môi trường desktop đầy đủ (GNOME); Xvfb cung cấp hiển thị.

Dùng cấu hình:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Image trình duyệt tùy chỉnh:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Khi bật, tác tử nhận được:

- URL điều khiển trình duyệt sandbox (cho công cụ `browser`)
- URL noVNC (nếu bật và headless=false)

Lưu ý: nếu bạn dùng allowlist cho công cụ, hãy thêm `browser` (và xóa khỏi
deny) nếu không công cụ vẫn bị chặn.
Quy tắc dọn dẹp (`agents.defaults.sandbox.prune`) cũng áp dụng cho container trình duyệt.

### Image sandbox tùy chỉnh

Build image của riêng bạn và trỏ cấu hình tới nó:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Chính sách công cụ (cho phép/từ chối)

- `deny` được ưu tiên hơn `allow`.
- Nếu `allow` trống: tất cả công cụ (trừ deny) đều khả dụng.
- Nếu `allow` không trống: chỉ các công cụ trong `allow` khả dụng (trừ deny).

### Chiến lược dọn dẹp

Hai nút:

- `prune.idleHours`: xóa container không dùng trong X giờ (0 = tắt)
- `prune.maxAgeDays`: xóa container cũ hơn X ngày (0 = tắt)

Ví dụ:

- Giữ các phiên bận rộn nhưng giới hạn tuổi thọ:
  `idleHours: 24`, `maxAgeDays: 7`
- Không bao giờ dọn dẹp:
  `idleHours: 0`, `maxAgeDays: 0`

### Ghi chú bảo mật

- Hàng rào cứng chỉ áp dụng cho **công cụ** (exec/read/write/edit/apply_patch).
- Công cụ chỉ chạy trên host như browser/camera/canvas bị chặn theo mặc định.
- Cho phép `browser` trong sandbox **phá vỡ cô lập** (trình duyệt chạy trên host).

## Xử lý sự cố

- Thiếu image: build bằng [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) hoặc đặt `agents.defaults.sandbox.docker.image`.
- Container không chạy: nó sẽ tự tạo theo phiên khi cần.
- Lỗi quyền trong sandbox: đặt `docker.user` thành UID:GID khớp với quyền sở hữu
  workspace được mount (hoặc chown thư mục workspace).
- Không tìm thấy công cụ tùy chỉnh: OpenClaw chạy lệnh với `sh -lc` (login shell),
  shell này sẽ source `/etc/profile` và có thể đặt lại PATH. Hãy đặt `docker.env.PATH` để
  thêm trước các đường dẫn công cụ tùy chỉnh (ví dụ: `/custom/bin:/usr/local/share/npm-global/bin`), hoặc thêm
  một script dưới `/etc/profile.d/` trong Dockerfile của bạn.
