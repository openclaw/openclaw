---
summary: "Skills: được quản lý so với workspace, quy tắc gating và kết nối config/env"
read_when:
  - Thêm hoặc chỉnh sửa skills
  - Thay đổi gating hoặc quy tắc tải skill
title: "Skills"
---

# Skills (OpenClaw)

6. Mỗi kỹ năng là một thư mục chứa `SKILL.md` với frontmatter YAML và hướng dẫn. 7. OpenClaw tải **các kỹ năng được đóng gói sẵn** cùng với các ghi đè cục bộ tùy chọn, và lọc chúng tại thời điểm tải dựa trên môi trường, cấu hình và sự hiện diện của binary. 8. Trong các thiết lập **đa agent**, mỗi agent có workspace riêng.

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

9. Điều đó có nghĩa là: 10. Plugin có thể phân phối các kỹ năng riêng của chúng bằng cách liệt kê các thư mục `skills` trong
   `openclaw.plugin.json` (đường dẫn tương đối so với gốc plugin).

- **Skills theo từng tác tử** nằm trong `<workspace>/skills` và chỉ dành cho tác tử đó.
- **Skills dùng chung** nằm trong `~/.openclaw/skills` (managed/local) và hiển thị
  cho **tất cả tác tử** trên cùng một máy.
- **Thư mục dùng chung** cũng có thể được thêm qua `skills.load.extraDirs` (ưu tiên thấp nhất)
  nếu bạn muốn một gói skills chung cho nhiều tác tử.

Nếu cùng một tên skill tồn tại ở nhiều nơi, thứ tự ưu tiên thông thường áp dụng:
workspace thắng, sau đó managed/local, rồi bundled.

## Plugin + skills

Plugins can ship their own skills by listing `skills` directories in
`openclaw.plugin.json` (paths relative to the plugin root). 12. Bạn có thể kiểm soát chúng thông qua `metadata.openclaw.requires.config` trên mục cấu hình của plugin.
13. Xem [Plugins](/tools/plugin) để biết cách khám phá/cấu hình và [Tools](/tools) để hiểu bề mặt công cụ mà các kỹ năng đó hướng dẫn. 14. ClawHub là registry kỹ năng công khai cho OpenClaw.

## ClawHub (cài đặt + đồng bộ)

15. Duyệt tại
    [https://clawhub.com](https://clawhub.com). 16. Sử dụng nó để khám phá, cài đặt, cập nhật và sao lưu kỹ năng. 17. Hướng dẫn đầy đủ: [ClawHub](/tools/clawhub).
16. Theo mặc định, `clawhub` cài đặt vào `./skills` dưới thư mục làm việc hiện tại của bạn
    (hoặc quay về workspace OpenClaw đã được cấu hình).

Các luồng phổ biến:

- Cài một skill vào workspace của bạn:
  - `clawhub install <skill-slug>`
- Cập nhật tất cả skills đã cài:
  - `clawhub update --all`
- Đồng bộ (quét + xuất bản cập nhật):
  - `clawhub sync --all`

19. OpenClaw sẽ nhận diện
    thư mục đó là `<workspace>/skills` ở phiên làm việc tiếp theo. 20. Hãy coi các kỹ năng của bên thứ ba là **mã không đáng tin cậy**.

## Ghi chú bảo mật

- 21. Đọc chúng trước khi bật. 22. Ưu tiên các lần chạy sandboxed cho đầu vào không đáng tin cậy và các công cụ rủi ro.
- 23. Xem [Sandboxing](/gateway/sandboxing). 24. `skills.entries.*.env` và `skills.entries.*.apiKey` chèn bí mật vào tiến trình **host**
      cho lượt agent đó (không phải sandbox).
- 25. Giữ bí mật ngoài prompt và log. 26. `user-invocable` — `true|false` (mặc định: `true`).
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
  - 27. Khi là `true`, kỹ năng được hiển thị như một lệnh slash cho người dùng. 28. `disable-model-invocation` — `true|false` (mặc định: `false`).
  - 29. Khi là `true`, kỹ năng bị loại khỏi prompt của mô hình (vẫn khả dụng qua việc gọi bởi người dùng). 30. `command-dispatch` — `tool` (tùy chọn).
  - 31. Khi đặt là `tool`, lệnh slash bỏ qua mô hình và điều phối trực tiếp tới một công cụ. 32. `command-arg-mode` — `raw` (mặc định).
  - `command-tool` — tên công cụ được gọi khi `command-dispatch: tool` được đặt.
  - 33. Đối với điều phối công cụ, chuyển tiếp chuỗi đối số thô tới công cụ (không phân tích ở lõi). 34. `os` — danh sách nền tảng tùy chọn (`darwin`, `linux`, `win32`).

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
- 35. Nếu được đặt, kỹ năng chỉ đủ điều kiện trên các hệ điều hành đó. 36. `primaryEnv` — tên biến môi trường được liên kết với `skills.entries.<name>`
  36. `.apiKey`.
- `requires.bins` — danh sách; mỗi mục phải tồn tại trên `PATH`.
- `requires.anyBins` — danh sách; ít nhất một mục phải tồn tại trên `PATH`.
- `requires.env` — danh sách; biến môi trường phải tồn tại **hoặc** được cung cấp trong cấu hình.
- `requires.config` — danh sách các đường dẫn `openclaw.json` phải có giá trị truthy.
- 38. Nếu một agent được sandboxed, binary cũng phải tồn tại **bên trong container**.39. Cài đặt nó thông qua `agents.defaults.sandbox.docker.setupCommand` (hoặc một image tùy chỉnh).
- `install` — mảng tùy chọn các đặc tả trình cài đặt dùng bởi UI Skills trên macOS (brew/node/go/uv/download).

Ghi chú về sandboxing:

- `requires.bins` được kiểm tra trên **host** tại thời điểm tải skill.
- 40. `setupCommand` chạy một lần sau khi container được tạo.
  41. Việc cài đặt gói cũng yêu cầu quyền truy cập mạng ra ngoài, hệ thống tệp gốc có thể ghi, và người dùng root trong sandbox.
  42. Ví dụ: kỹ năng `summarize` (`skills/summarize/SKILL.md`) cần CLI `summarize`
      trong container sandbox để chạy ở đó.
  43. Cài đặt Node tuân theo `skills.install.nodeManager` trong `openclaw.json` (mặc định: npm; tùy chọn: npm/pnpm/yarn/bun).
  44. Điều này chỉ ảnh hưởng đến **việc cài đặt kỹ năng**; runtime Gateway vẫn nên là Node
      (Bun không được khuyến nghị cho WhatsApp/Telegram).

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
- 45. Các khóa cấu hình khớp với **tên kỹ năng** theo mặc định.
  46. Nếu một kỹ năng định nghĩa
      `metadata.openclaw.skillKey`, hãy dùng khóa đó dưới `skills.entries`.
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

47. `allowBundled`: allowlist tùy chọn chỉ cho các kỹ năng **được đóng gói sẵn**. 48. Nếu được đặt, chỉ các kỹ năng đóng gói sẵn trong danh sách mới đủ điều kiện (các kỹ năng được quản lý/workspace không bị ảnh hưởng).

Quy tắc:

- `enabled: false` tắt skill ngay cả khi nó được bundle/cài đặt.
- `env`: chỉ chèn **nếu** biến chưa được đặt trong tiến trình.
- `apiKey`: tiện ích cho các skills khai báo `metadata.openclaw.primaryEnv`.
- `config`: túi tùy chọn cho các trường tùy chỉnh theo từng skill; các khóa tùy chỉnh phải nằm ở đây.
- 49. Áp dụng mọi `skills.entries.<key>`
  50. `.env` hoặc `skills.entries.<key>` If set, only
      bundled skills in the list are eligible (managed/workspace skills unaffected).

## Chèn môi trường (theo mỗi lần chạy tác tử)

Khi một lần chạy tác tử bắt đầu, OpenClaw:

1. Đọc metadata của skill.
2. Applies any `skills.entries.<key>.env` or `skills.entries.<key>7. .apiKey` sang
   `process.env`.
3. Xây dựng system prompt với các skills **đủ điều kiện**.
4. Khôi phục môi trường ban đầu sau khi lần chạy kết thúc.

Điều này **chỉ phạm vi cho lần chạy tác tử**, không phải môi trường shell toàn cục.

## Snapshot phiên (hiệu năng)

OpenClaw snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.

Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.

## Node macOS từ xa (Gateway Linux)

If the Gateway is running on Linux but a **macOS node** is connected **with `system.run` allowed** (Exec approvals security not set to `deny`), OpenClaw can treat macOS-only skills as eligible when the required binaries are present on that node. The agent should execute those skills via the `nodes` tool (typically `nodes.run`).

This relies on the node reporting its command support and on a bin probe via `system.run`. 2. Nếu node macOS bị offline sau đó, các kỹ năng vẫn hiển thị; việc gọi có thể thất bại cho đến khi node kết nối lại.

## Skills watcher (tự động làm mới)

3. Theo mặc định, OpenClaw theo dõi các thư mục kỹ năng và tăng snapshot kỹ năng khi các tệp `SKILL.md` thay đổi. 4. Cấu hình mục này dưới `skills.load`:

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

11. Khi các skill đủ điều kiện, OpenClaw chèn một danh sách XML gọn nhẹ các skill khả dụng vào system prompt (thông qua `formatSkillsForPrompt` trong `pi-coding-agent`). 12. Chi phí là xác định:

- **Chi phí cơ bản (chỉ khi ≥1 skill):** 195 ký tự.
- **Mỗi skill:** 97 ký tự + độ dài của các giá trị `<name>`, `<description>` và `<location>` sau khi escape XML.

Công thức (ký tự):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Ghi chú:

- Escape XML mở rộng `& < > " '` thành các entity (`&amp;`, `&lt;`, v.v.), làm tăng độ dài.
- 5. Số lượng token thay đổi tùy theo tokenizer của từng mô hình. A rough OpenAI-style estimate is ~4 chars/token, so **97 chars ≈ 24 tokens** per skill plus your actual field lengths.

## Vòng đời managed skills

6. OpenClaw cung cấp một tập kỹ năng cơ sở dưới dạng **kỹ năng đi kèm (bundled skills)** như một phần của
   quá trình cài đặt (gói npm hoặc OpenClaw.app). `~/.openclaw/skills` exists for local
   overrides (for example, pinning/patching a skill without changing the bundled
   copy). 7. Kỹ năng workspace thuộc về người dùng và sẽ ghi đè cả hai khi trùng tên.

## Tham chiếu cấu hình

Xem [Skills config](/tools/skills-config) để biết schema cấu hình đầy đủ.

## Tìm thêm skills?

Duyệt [https://clawhub.com](https://clawhub.com).

---
