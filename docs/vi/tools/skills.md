---
summary: "Skills: được quản lý so với workspace, quy tắc gating và kết nối config/env"
read_when:
  - Thêm hoặc chỉnh sửa skills
  - Thay đổi gating hoặc quy tắc tải skill
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:52Z
---

# Skills (OpenClaw)

OpenClaw sử dụng các thư mục skill **tương thích với [AgentSkills](https://agentskills.io)** để dạy tác tử cách dùng công cụ. Mỗi skill là một thư mục chứa `SKILL.md` với YAML frontmatter và phần hướng dẫn. OpenClaw tải **skills đi kèm** cùng với các ghi đè cục bộ tùy chọn, và lọc chúng tại thời điểm tải dựa trên môi trường, cấu hình và sự hiện diện của binary.

## Vị trí và thứ tự ưu tiên

Skills được tải từ **ba** nơi:

1. **Bundled skills**: đi kèm bản cài đặt (gói npm hoặc OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

Nếu trùng tên skill, thứ tự ưu tiên là:

`<workspace>/skills` (cao nhất) → `~/.openclaw/skills` → bundled skills (thấp nhất)

Ngoài ra, bạn có thể cấu hình thêm các thư mục skill bổ sung (ưu tiên thấp nhất) qua
`skills.load.extraDirs` trong `~/.openclaw/openclaw.json`.

## Skills theo từng tác tử vs dùng chung

Trong các thiết lập **đa tác tử**, mỗi tác tử có workspace riêng. Điều đó có nghĩa là:

- **Skills theo từng tác tử** nằm trong `<workspace>/skills` và chỉ dành cho tác tử đó.
- **Skills dùng chung** nằm trong `~/.openclaw/skills` (managed/local) và hiển thị
  cho **tất cả tác tử** trên cùng một máy.
- **Thư mục dùng chung** cũng có thể được thêm qua `skills.load.extraDirs` (ưu tiên thấp nhất)
  nếu bạn muốn một gói skills chung cho nhiều tác tử.

Nếu cùng một tên skill tồn tại ở nhiều nơi, thứ tự ưu tiên thông thường áp dụng:
workspace thắng, sau đó managed/local, rồi bundled.

## Plugin + skills

Plugin có thể đi kèm skills riêng bằng cách liệt kê các thư mục `skills` trong
`openclaw.plugin.json` (đường dẫn tương đối so với thư mục gốc của plugin). Skills của plugin được tải
khi plugin được bật và tham gia vào các quy tắc ưu tiên skill thông thường.
Bạn có thể gate chúng qua `metadata.openclaw.requires.config` trên mục cấu hình của plugin.
Xem [Plugins](/tools/plugin) để biết khám phá/cấu hình và [Tools](/tools) cho bề mặt công cụ mà các skills đó dạy.

## ClawHub (cài đặt + đồng bộ)

ClawHub là registry skills công khai cho OpenClaw. Duyệt tại
[https://clawhub.com](https://clawhub.com). Dùng để khám phá, cài đặt, cập nhật và sao lưu skills.
Hướng dẫn đầy đủ: [ClawHub](/tools/clawhub).

Các luồng phổ biến:

- Cài một skill vào workspace của bạn:
  - `clawhub install <skill-slug>`
- Cập nhật tất cả skills đã cài:
  - `clawhub update --all`
- Đồng bộ (quét + xuất bản cập nhật):
  - `clawhub sync --all`

Theo mặc định, `clawhub` cài vào `./skills` dưới thư mục làm việc hiện tại
(hoặc dùng workspace OpenClaw đã cấu hình). OpenClaw nhận diện
điều đó như `<workspace>/skills` ở phiên tiếp theo.

## Ghi chú bảo mật

- Hãy coi skills của bên thứ ba là **mã không đáng tin cậy**. Đọc kỹ trước khi bật.
- Ưu tiên chạy trong sandbox cho các đầu vào không đáng tin cậy và công cụ rủi ro. Xem [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` và `skills.entries.*.apiKey` chèn bí mật vào **tiến trình host**
  cho lượt tác tử đó (không phải sandbox). Giữ bí mật tránh khỏi prompt và log.
- Để có mô hình đe dọa và checklist rộng hơn, xem [Security](/gateway/security).

## Định dạng (AgentSkills + tương thích Pi)

`SKILL.md` phải bao gồm ít nhất:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Ghi chú:

- Chúng tôi tuân theo đặc tả AgentSkills về bố cục/mục đích.
- Trình phân tích dùng bởi tác tử nhúng chỉ hỗ trợ khóa frontmatter **một dòng**.
- `metadata` nên là **đối tượng JSON một dòng**.
- Dùng `{baseDir}` trong phần hướng dẫn để tham chiếu đường dẫn thư mục skill.
- Các khóa frontmatter tùy chọn:
  - `homepage` — URL hiển thị là “Website” trong UI Skills trên macOS (cũng hỗ trợ qua `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (mặc định: `true`). Khi `true`, skill được hiển thị như một lệnh slash cho người dùng.
  - `disable-model-invocation` — `true|false` (mặc định: `false`). Khi `true`, skill bị loại khỏi prompt của mô hình (vẫn có thể dùng qua gọi từ người dùng).
  - `command-dispatch` — `tool` (tùy chọn). Khi đặt là `tool`, lệnh slash bỏ qua mô hình và gửi trực tiếp tới công cụ.
  - `command-tool` — tên công cụ được gọi khi `command-dispatch: tool` được đặt.
  - `command-arg-mode` — `raw` (mặc định). Với điều phối công cụ, chuyển tiếp chuỗi args thô tới công cụ (không phân tích ở core).

    Công cụ được gọi với tham số:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Gating (bộ lọc khi tải)

OpenClaw **lọc skills tại thời điểm tải** bằng `metadata` (JSON một dòng):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

Các trường dưới `metadata.openclaw`:

- `always: true` — luôn bao gồm skill (bỏ qua các gate khác).
- `emoji` — emoji tùy chọn dùng bởi UI Skills trên macOS.
- `homepage` — URL tùy chọn hiển thị là “Website” trong UI Skills trên macOS.
- `os` — danh sách nền tảng tùy chọn (`darwin`, `linux`, `win32`). Nếu đặt, skill chỉ đủ điều kiện trên các OS đó.
- `requires.bins` — danh sách; mỗi mục phải tồn tại trên `PATH`.
- `requires.anyBins` — danh sách; ít nhất một mục phải tồn tại trên `PATH`.
- `requires.env` — danh sách; biến môi trường phải tồn tại **hoặc** được cung cấp trong cấu hình.
- `requires.config` — danh sách các đường dẫn `openclaw.json` phải có giá trị truthy.
- `primaryEnv` — tên biến môi trường liên kết với `skills.entries.<name>.apiKey`.
- `install` — mảng tùy chọn các đặc tả trình cài đặt dùng bởi UI Skills trên macOS (brew/node/go/uv/download).

Ghi chú về sandboxing:

- `requires.bins` được kiểm tra trên **host** tại thời điểm tải skill.
- Nếu tác tử chạy trong sandbox, binary cũng phải tồn tại **bên trong container**.
  Cài đặt nó qua `agents.defaults.sandbox.docker.setupCommand` (hoặc image tùy chỉnh).
  `setupCommand` chạy một lần sau khi container được tạo.
  Việc cài gói cũng yêu cầu egress mạng, FS gốc có thể ghi, và người dùng root trong sandbox.
  Ví dụ: skill `summarize` (`skills/summarize/SKILL.md`) cần CLI `summarize`
  trong container sandbox để chạy tại đó.

Ví dụ trình cài đặt:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Ghi chú:

- Nếu liệt kê nhiều trình cài đặt, gateway chọn **một** tùy chọn ưu tiên (brew khi có, nếu không thì node).
- Nếu tất cả trình cài đặt là `download`, OpenClaw liệt kê từng mục để bạn thấy các artifact khả dụng.
- Đặc tả trình cài đặt có thể bao gồm `os: ["darwin"|"linux"|"win32"]` để lọc tùy chọn theo nền tảng.
- Cài đặt Node tuân theo `skills.install.nodeManager` trong `openclaw.json` (mặc định: npm; tùy chọn: npm/pnpm/yarn/bun).
  Điều này chỉ ảnh hưởng đến **cài đặt skill**; runtime của Gateway vẫn nên là Node
  (không khuyến nghị Bun cho WhatsApp/Telegram).
- Cài đặt Go: nếu `go` thiếu và `brew` khả dụng, gateway cài Go qua Homebrew trước và đặt `GOBIN` thành `bin` của Homebrew khi có thể.
- Cài đặt download: `url` (bắt buộc), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (mặc định: auto khi phát hiện archive), `stripComponents`, `targetDir` (mặc định: `~/.openclaw/tools/<skillKey>`).

Nếu không có `metadata.openclaw`, skill luôn đủ điều kiện (trừ khi
bị tắt trong cấu hình hoặc bị chặn bởi `skills.allowBundled` đối với bundled skills).

## Ghi đè cấu hình (`~/.openclaw/openclaw.json`)

Bundled/managed skills có thể được bật/tắt và cung cấp giá trị env:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Lưu ý: nếu tên skill chứa dấu gạch nối, hãy đặt khóa trong dấu ngoặc kép (JSON5 cho phép khóa có dấu ngoặc kép).

Các khóa cấu hình mặc định khớp với **tên skill**. Nếu một skill định nghĩa
`metadata.openclaw.skillKey`, hãy dùng khóa đó dưới `skills.entries`.

Quy tắc:

- `enabled: false` tắt skill ngay cả khi nó được bundle/cài đặt.
- `env`: chỉ chèn **nếu** biến chưa được đặt trong tiến trình.
- `apiKey`: tiện ích cho các skills khai báo `metadata.openclaw.primaryEnv`.
- `config`: túi tùy chọn cho các trường tùy chỉnh theo từng skill; các khóa tùy chỉnh phải nằm ở đây.
- `allowBundled`: allowlist tùy chọn chỉ cho **bundled** skills. Nếu đặt, chỉ
  các bundled skills trong danh sách đủ điều kiện (managed/workspace không bị ảnh hưởng).

## Chèn môi trường (theo mỗi lần chạy tác tử)

Khi một lần chạy tác tử bắt đầu, OpenClaw:

1. Đọc metadata của skill.
2. Áp dụng mọi `skills.entries.<key>.env` hoặc `skills.entries.<key>.apiKey` vào
   `process.env`.
3. Xây dựng system prompt với các skills **đủ điều kiện**.
4. Khôi phục môi trường ban đầu sau khi lần chạy kết thúc.

Điều này **chỉ phạm vi cho lần chạy tác tử**, không phải môi trường shell toàn cục.

## Snapshot phiên (hiệu năng)

OpenClaw chụp snapshot danh sách skills đủ điều kiện **khi một phiên bắt đầu** và tái sử dụng danh sách đó cho các lượt tiếp theo trong cùng phiên. Thay đổi về skills hoặc cấu hình sẽ có hiệu lực ở phiên mới tiếp theo.

Skills cũng có thể làm mới giữa phiên khi skills watcher được bật hoặc khi một node từ xa đủ điều kiện mới xuất hiện (xem bên dưới). Hãy coi đây là **hot reload**: danh sách đã làm mới được áp dụng ở lượt tác tử tiếp theo.

## Node macOS từ xa (Gateway Linux)

Nếu Gateway chạy trên Linux nhưng có **node macOS** được kết nối **với `system.run` được cho phép** (bảo mật phê duyệt Exec không đặt là `deny`), OpenClaw có thể coi các skills chỉ dành cho macOS là đủ điều kiện khi các binary cần thiết tồn tại trên node đó. Tác tử nên thực thi các skills này qua công cụ `nodes` (thường là `nodes.run`).

Điều này dựa vào việc node báo cáo khả năng hỗ trợ lệnh và vào việc dò bin qua `system.run`. Nếu node macOS sau đó offline, các skills vẫn hiển thị; việc gọi có thể thất bại cho đến khi node kết nối lại.

## Skills watcher (tự động làm mới)

Theo mặc định, OpenClaw theo dõi các thư mục skill và tăng snapshot skills khi các tệp `SKILL.md` thay đổi. Cấu hình điều này dưới `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Tác động token (danh sách skills)

Khi skills đủ điều kiện, OpenClaw chèn một danh sách XML gọn nhẹ các skills khả dụng vào system prompt (qua `formatSkillsForPrompt` trong `pi-coding-agent`). Chi phí là xác định:

- **Chi phí cơ bản (chỉ khi ≥1 skill):** 195 ký tự.
- **Mỗi skill:** 97 ký tự + độ dài của các giá trị `<name>`, `<description>` và `<location>` sau khi escape XML.

Công thức (ký tự):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Ghi chú:

- Escape XML mở rộng `& < > " '` thành các entity (`&amp;`, `&lt;`, v.v.), làm tăng độ dài.
- Số token thay đổi theo tokenizer của mô hình. Ước tính kiểu OpenAI là ~4 ký tự/token, vì vậy **97 ký tự ≈ 24 token** cho mỗi skill cộng với độ dài thực tế của các trường.

## Vòng đời managed skills

OpenClaw phát hành một bộ skills cơ bản dưới dạng **bundled skills** như một phần của
bản cài đặt (gói npm hoặc OpenClaw.app). `~/.openclaw/skills` tồn tại cho các
ghi đè cục bộ (ví dụ: ghim/ vá một skill mà không thay đổi bản bundled).
Workspace skills thuộc sở hữu người dùng và ghi đè cả hai khi trùng tên.

## Tham chiếu cấu hình

Xem [Skills config](/tools/skills-config) để biết schema cấu hình đầy đủ.

## Tìm thêm skills?

Duyệt [https://clawhub.com](https://clawhub.com).

---
