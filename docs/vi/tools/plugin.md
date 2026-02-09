---
summary: "Plugin/extension OpenClaw: khám phá, cấu hình và an toàn"
read_when:
  - Thêm hoặc chỉnh sửa plugin/extension
  - Viết tài liệu về quy tắc cài đặt hoặc tải plugin
title: "Plugin"
---

# Plugin (Extension)

## Khởi động nhanh (mới làm quen với plugin?)

Plugin chỉ là một **mô-đun mã nhỏ** giúp mở rộng OpenClaw với các
tính năng bổ sung (lệnh, công cụ và RPC của Gateway).

Phần lớn thời gian, bạn sẽ dùng plugin khi cần một tính năng chưa có
trong OpenClaw lõi (hoặc bạn muốn giữ các tính năng tùy chọn nằm ngoài
bản cài đặt chính).

Lộ trình nhanh:

1. Xem những gì đang được tải:

```bash
openclaw plugins list
```

2. Cài một plugin chính thức (ví dụ: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. 22. Khởi động lại Gateway, sau đó cấu hình dưới `plugins.entries.<id>`..config\`.

Xem [Voice Call](/plugins/voice-call) để có một ví dụ plugin cụ thể.

## Plugin khả dụng (chính thức)

- Microsoft Teams chỉ có dưới dạng plugin kể từ 2026.1.15; cài `@openclaw/msteams` nếu bạn dùng Teams.
- Memory (Core) — plugin tìm kiếm bộ nhớ đi kèm (bật mặc định qua `plugins.slots.memory`)
- Memory (LanceDB) — plugin bộ nhớ dài hạn đi kèm (tự động gọi lại/ghi nhận; đặt `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (xác thực nhà cung cấp) — đi kèm dưới dạng `google-antigravity-auth` (tắt theo mặc định)
- Gemini CLI OAuth (xác thực nhà cung cấp) — đi kèm dưới dạng `google-gemini-cli-auth` (tắt theo mặc định)
- Qwen OAuth (xác thực nhà cung cấp) — đi kèm dưới dạng `qwen-portal-auth` (tắt theo mặc định)
- Copilot Proxy (xác thực nhà cung cấp) — cầu nối Copilot Proxy cục bộ cho VS Code; khác với đăng nhập thiết bị `github-copilot` tích hợp sẵn (đi kèm, tắt theo mặc định)

OpenClaw plugins are **TypeScript modules** loaded at runtime via jiti. 24. **Xác thực cấu hình không thực thi mã plugin**; nó sử dụng manifest plugin và JSON Schema thay vào đó. 25. Xem [Plugin manifest](/plugins/manifest).

Plugin có thể đăng ký:

- Phương thức RPC của Gateway
- Trình xử lý HTTP của Gateway
- Công cụ tác tử
- Lệnh CLI
- Dịch vụ nền
- Xác thực cấu hình tùy chọn
- **Skills** (bằng cách liệt kê các thư mục `skills` trong manifest plugin)
- **Lệnh trả lời tự động** (thực thi mà không gọi tác tử AI)

26. Plugin chạy **in‑process** cùng Gateway, vì vậy hãy coi chúng là mã đáng tin cậy.
27. Hướng dẫn viết công cụ: [Plugin agent tools](/plugins/agent-tools).

## Trợ giúp lúc chạy

Plugins can access selected core helpers via `api.runtime`. For telephony TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Ghi chú:

- Dùng cấu hình lõi `messages.tts` (OpenAI hoặc ElevenLabs).
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- Edge TTS không được hỗ trợ cho thoại.

## Khám phá & thứ tự ưu tiên

OpenClaw quét theo thứ tự:

1. Đường dẫn cấu hình

- `plugins.load.paths` (tệp hoặc thư mục)

2. Extension trong workspace

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Extension toàn cục

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Extension đi kèm (phát hành cùng OpenClaw, **tắt theo mặc định**)

- `<openclaw>/extensions/*`

Bundled plugins must be enabled explicitly via `plugins.entries.<id>.enabled`
or `openclaw plugins enable <id>`. Installed plugins are enabled by default,
but can be disabled the same way.

Each plugin must include a `openclaw.plugin.json` file in its root. If a path
points at a file, the plugin root is the file's directory and must contain the
manifest.

Nếu nhiều plugin trùng id, bản khớp đầu tiên theo thứ tự trên sẽ thắng
và các bản có ưu tiên thấp hơn sẽ bị bỏ qua.

### Gói pack

Một thư mục plugin có thể chứa `package.json` với `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

Nếu plugin của bạn nhập phụ thuộc npm, hãy cài chúng trong thư mục đó để
`node_modules` khả dụng (`npm install` / `pnpm install`).

### Metadata danh mục kênh

Channel plugins can advertise onboarding metadata via `openclaw.channel` and
install hints via `openclaw.install`. 40. Điều này giúp dữ liệu danh mục lõi không chứa dữ liệu.

Ví dụ:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

41. OpenClaw cũng có thể hợp nhất **các danh mục kênh bên ngoài** (ví dụ: một bản xuất registry MPM). 42. Thả một tệp JSON vào một trong các vị trí:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

43. Hoặc trỏ `OPENCLAW_PLUGIN_CATALOG_PATHS` (hoặc `OPENCLAW_MPM_CATALOG_PATHS`) tới một hoặc nhiều tệp JSON (phân tách bằng dấu phẩy/chấm phẩy/`PATH`). 44. Mỗi tệp nên chứa `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## ID plugin

ID plugin mặc định:

- Gói pack: `package.json` `name`
- Tệp độc lập: tên cơ sở của tệp (`~/.../voice-call.ts` → `voice-call`)

Nếu plugin xuất `id`, OpenClaw sẽ dùng nó nhưng cảnh báo khi không khớp
với id đã cấu hình.

## Cấu hình

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Các trường:

- `enabled`: công tắc tổng (mặc định: true)
- `allow`: danh sách cho phép (tùy chọn)
- `deny`: danh sách chặn (tùy chọn; chặn được ưu tiên)
- `load.paths`: tệp/thư mục plugin bổ sung
- 46. \`entries.<id>\`\`: per‑plugin toggles + config

Thay đổi cấu hình **yêu cầu khởi động lại gateway**.

Quy tắc xác thực (nghiêm ngặt):

- ID plugin không xác định trong `entries`, `allow`, `deny` hoặc `slots` là **lỗi**.
- Unknown `channels.<id>` keys are **errors** unless a plugin manifest declares
  the channel id.
- Cấu hình plugin được xác thực bằng JSON Schema nhúng trong
  `openclaw.plugin.json` (`configSchema`).
- Nếu plugin bị tắt, cấu hình của nó vẫn được giữ và phát ra **cảnh báo**.

## Khe plugin (danh mục độc quyền)

Some plugin categories are **exclusive** (only one active at a time). Use
`plugins.slots` to select which plugin owns the slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

If multiple plugins declare `kind: "memory"`, only the selected one loads. Others
are disabled with diagnostics.

## Control UI (schema + nhãn)

Control UI dùng `config.schema` (JSON Schema + `uiHints`) để hiển thị biểu mẫu tốt hơn.

OpenClaw bổ sung `uiHints` lúc chạy dựa trên các plugin được phát hiện:

- Adds per-plugin labels for `plugins.entries.<id>` / `.enabled` / `.config`
- Merges optional plugin-provided config field hints under:
  `plugins.entries.<id>.config.<field>`

Nếu bạn muốn các trường cấu hình plugin hiển thị nhãn/placeholder tốt (và đánh dấu bí mật là nhạy cảm),
hãy cung cấp `uiHints` cùng JSON Schema trong manifest plugin.

Ví dụ:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` chỉ hoạt động với các cài đặt npm được theo dõi dưới `plugins.installs`.

Plugin cũng có thể đăng ký các lệnh cấp cao riêng (ví dụ: `openclaw voicecall`).

## API plugin (tổng quan)

Plugin xuất một trong hai:

- A function: `(api) => { ... }`
- An object: `{ id, name, configSchema, register(api) { ... } }`

## Hook plugin

Plugins can ship hooks and register them at runtime. This lets a plugin bundle
event-driven automation without a separate hook pack install.

### Ví dụ

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Ghi chú:

- Thư mục hook tuân theo cấu trúc hook thông thường (`HOOK.md` + `handler.ts`).
- Quy tắc đủ điều kiện của hook vẫn áp dụng (OS/bins/env/yêu cầu cấu hình).
- Hook do plugin quản lý xuất hiện trong `openclaw hooks list` với `plugin:<id>`.
- Bạn không thể bật/tắt hook do plugin quản lý qua `openclaw hooks`; hãy bật/tắt plugin thay thế.

## Plugin nhà cung cấp (xác thực mô hình)

Plugin có thể đăng ký luồng **xác thực nhà cung cấp mô hình** để người dùng chạy OAuth hoặc
thiết lập khóa API ngay trong OpenClaw (không cần script bên ngoài).

Register a provider via `api.registerProvider(...)`. Each provider exposes one
or more auth methods (OAuth, API key, device code, etc.). These methods power:

- `openclaw models auth login --provider <id> [--method <id>]`

Ví dụ:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

Ghi chú:

- `run` nhận một `ProviderAuthContext` với các helper `prompter`, `runtime`,
  `openUrl` và `oauth.createVpsAwareHandlers`.
- Trả về `configPatch` khi bạn cần thêm mô hình mặc định hoặc cấu hình nhà cung cấp.
- Trả về `defaultModel` để `--set-default` có thể cập nhật mặc định tác tử.

### Đăng ký kênh nhắn tin

Plugins can register **channel plugins** that behave like built‑in channels
(WhatsApp, Telegram, etc.). Channel config lives under `channels.<id>` and is
validated by your channel plugin code.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

Ghi chú:

- Put config under `channels.<id>` (not `plugins.entries`).
- `meta.label` được dùng làm nhãn trong danh sách CLI/UI.
- `meta.aliases` thêm các id thay thế cho chuẩn hóa và đầu vào CLI.
- `meta.preferOver` liệt kê các id kênh để bỏ qua tự động bật khi cả hai được cấu hình.
- `meta.detailLabel` và `meta.systemImage` cho phép UI hiển thị nhãn/biểu tượng kênh phong phú hơn.

### Viết kênh nhắn tin mới (từng bước)

Use this when you want a **new chat surface** (a “messaging channel”), not a model provider.
Model provider docs live under `/providers/*`.

1. Chọn id + hình dạng cấu hình

- All channel config lives under `channels.<id>`.
- Prefer `channels.<id>.accounts.<accountId>` for multi‑account setups.

2. Định nghĩa metadata kênh

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` điều khiển danh sách CLI/UI.
- `meta.docsPath` nên trỏ tới trang tài liệu như `/channels/<id>`.
- `meta.preferOver` cho phép plugin thay thế một kênh khác (tự động bật sẽ ưu tiên nó).
- `meta.detailLabel` và `meta.systemImage` được UI dùng cho văn bản/biểu tượng chi tiết.

3. Triển khai các adapter bắt buộc

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (kiểu chat, media, luồng, v.v.)
- `outbound.deliveryMode` + `outbound.sendText` (cho gửi cơ bản)

4. Thêm adapter tùy chọn khi cần

- `setup` (wizard), `security` (chính sách DM), `status` (tình trạng/chẩn đoán)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (hành động tin nhắn), `commands` (hành vi lệnh gốc)

5. Đăng ký kênh trong plugin của bạn

- `api.registerChannel({ plugin })`

Ví dụ cấu hình tối thiểu:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

Plugin kênh tối thiểu (chỉ outbound):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Load the plugin (extensions dir or `plugins.load.paths`), restart the gateway,
then configure `channels.<id>` in your config.

### Công cụ tác tử

Xem hướng dẫn riêng: [Plugin agent tools](/plugins/agent-tools).

### Đăng ký phương thức RPC của gateway

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Đăng ký lệnh CLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Đăng ký lệnh trả lời tự động

Plugins can register custom slash commands that execute **without invoking the
AI agent**. This is useful for toggle commands, status checks, or quick actions
that don't need LLM processing.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

Ngữ cảnh xử lý lệnh:

- `senderId`: ID người gửi (nếu có)
- `channel`: Kênh nơi lệnh được gửi
- `isAuthorizedSender`: Người gửi có được ủy quyền hay không
- `args`: Đối số truyền sau lệnh (nếu `acceptsArgs: true`)
- `commandBody`: Toàn bộ văn bản lệnh
- `config`: Cấu hình OpenClaw hiện tại

Tùy chọn lệnh:

- `name`: Tên lệnh (không có ký tự `/` ở đầu)
- `description`: Văn bản trợ giúp hiển thị trong danh sách lệnh
- `acceptsArgs`: Whether the command accepts arguments (default: false). 48. Nếu là false và có tham số được cung cấp, lệnh sẽ không khớp và thông điệp sẽ rơi xuống các handler khác
- `requireAuth`: Có yêu cầu người gửi được ủy quyền hay không (mặc định: true)
- `handler`: Hàm trả về `{ text: string }` (có thể async)

Ví dụ có ủy quyền và đối số:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

Ghi chú:

- Lệnh plugin được xử lý **trước** lệnh tích hợp sẵn và tác tử AI
- Lệnh được đăng ký toàn cục và hoạt động trên mọi kênh
- Tên lệnh không phân biệt hoa/thường (`/MyStatus` khớp `/mystatus`)
- Tên lệnh phải bắt đầu bằng chữ cái và chỉ chứa chữ cái, số, dấu gạch nối và gạch dưới
- 49. Tên lệnh được dành riêng (như `help`, `status`, `reset`, v.v.) cannot be overridden by plugins
- Đăng ký trùng lệnh giữa các plugin sẽ thất bại với lỗi chẩn đoán

### Đăng ký dịch vụ nền

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Quy ước đặt tên

- Phương thức Gateway: `pluginId.action` (ví dụ: `voicecall.status`)
- Công cụ: `snake_case` (ví dụ: `voice_call`)
- Lệnh CLI: kebab hoặc camel, nhưng tránh trùng với lệnh lõi

## Skills

Plugins can ship a skill in the repo (`skills/<name>/SKILL.md`).
Enable it with `plugins.entries.<id>.enabled` (or other config gates) and ensure
it’s present in your workspace/managed skills locations.

## Phân phối (npm)

Đóng gói khuyến nghị:

- Gói chính: `openclaw` (repo này)
- Plugin: các gói npm riêng dưới `@openclaw/*` (ví dụ: `@openclaw/voice-call`)

Hợp đồng phát hành:

- `package.json` của plugin phải bao gồm `openclaw.extensions` với một hoặc nhiều tệp entry.
- Tệp entry có thể là `.js` hoặc `.ts` (jiti tải TS lúc chạy).
- `openclaw plugins install <npm-spec>` dùng `npm pack`, giải nén vào `~/.openclaw/extensions/<id>/`, và bật trong cấu hình.
- Tính ổn định khóa cấu hình: các gói có scope được chuẩn hóa về id **không scope** cho `plugins.entries.*`.

## Plugin ví dụ: Voice Call

Repo này bao gồm plugin gọi thoại (Twilio hoặc fallback ghi log):

- Mã nguồn: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Công cụ: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Cấu hình (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (tùy chọn `statusCallbackUrl`, `twimlUrl`)
- Cấu hình (dev): `provider: "log"` (không mạng)

Xem [Voice Call](/plugins/voice-call) và `extensions/voice-call/README.md` để thiết lập và sử dụng.

## Ghi chú an toàn

3. Plugin chạy trong cùng tiến trình với Gateway. 4. Hãy coi chúng là mã đáng tin cậy:

- Chỉ cài plugin bạn tin tưởng.
- Ưu tiên danh sách cho phép `plugins.allow`.
- Khởi động lại Gateway sau khi thay đổi.

## Kiểm thử plugin

Plugin có thể (và nên) đi kèm kiểm thử:

- Plugin trong repo có thể đặt kiểm thử Vitest dưới `src/**` (ví dụ: `src/plugins/voice-call.plugin.test.ts`).
- Plugin phát hành riêng nên chạy CI riêng (lint/build/test) và xác thực `openclaw.extensions` trỏ tới entrypoint đã build (`dist/index.js`).
