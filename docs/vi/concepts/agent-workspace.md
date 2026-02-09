---
summary: "Workspace của tác tử: vị trí, bố cục và chiến lược sao lưu"
read_when:
  - Bạn cần giải thích workspace của tác tử hoặc bố cục tệp của nó
  - Bạn muốn sao lưu hoặc di chuyển workspace của tác tử
title: "Workspace của tác tử"
---

# Workspace của tác tử

**Quan trọng:** workspace là **cwd mặc định**, không phải sandbox cứng. It is the only working directory used for
file tools and for workspace context. Keep it private and treat it as memory.

Nó tách biệt với `~/.openclaw/`, nơi lưu cấu hình, thông tin xác thực và các phiên.

Nếu cần cách ly, hãy dùng
[`agents.defaults.sandbox`](/gateway/sandboxing) (và/hoặc cấu hình sandbox theo từng agent). Tools
resolve relative paths against the workspace, but absolute paths can still reach
elsewhere on the host unless sandboxing is enabled. Các bản cài đặt cũ có thể đã tạo `~/openclaw`.
When sandboxing is enabled and `workspaceAccess` is not `"rw"`, tools operate
inside a sandbox workspace under `~/.openclaw/sandboxes`, not your host workspace.

## Vị trí mặc định

- Mặc định: `~/.openclaw/workspace`
- Nếu `OPENCLAW_PROFILE` được đặt và không phải `"default"`, mặc định sẽ là
  `~/.openclaw/workspace-<profile>`.
- Ghi đè trong `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` hoặc `openclaw setup` sẽ tạo workspace và khởi tạo
các tệp bootstrap nếu chúng bị thiếu.

Nếu bạn đã tự quản lý các tệp workspace, bạn có thể tắt việc tạo tệp bootstrap:

```json5
{ agent: { skipBootstrap: true } }
```

## Thư mục workspace bổ sung

**Khuyến nghị:** chỉ giữ một workspace đang hoạt động. Keeping multiple workspace
directories around can cause confusing auth or state drift, because only one
workspace is active at a time.

**Recommendation:** keep a single active workspace. If you no longer use the
extra folders, archive or move them to Trash (for example `trash ~/openclaw`).
If you intentionally keep multiple workspaces, make sure
`agents.defaults.workspace` points to the active one.

`openclaw doctor` sẽ cảnh báo khi phát hiện có thêm thư mục workspace.

## Bản đồ tệp workspace (ý nghĩa của từng tệp)

Đây là các tệp tiêu chuẩn mà OpenClaw mong đợi bên trong workspace:

- `AGENTS.md`
  - Hướng dẫn vận hành cho tác tử và cách nó nên sử dụng bộ nhớ.
  - Được tải khi bắt đầu mỗi phiên.
  - Nơi phù hợp để đặt các quy tắc, ưu tiên và chi tiết “cách hành xử”.

- `SOUL.md`
  - Nhân dạng, giọng điệu và các ranh giới.
  - Được tải trong mọi phiên.

- `USER.md`
  - Người dùng là ai và cách xưng hô.
  - Được tải trong mọi phiên.

- `IDENTITY.md`
  - Tên, phong cách và emoji của tác tử.
  - Được tạo/cập nhật trong nghi thức bootstrap.

- `TOOLS.md`
  - Ghi chú về các công cụ cục bộ và quy ước của bạn.
  - Không kiểm soát khả năng dùng công cụ; chỉ mang tính hướng dẫn.

- `HEARTBEAT.md`
  - Checklist nhỏ tùy chọn cho các lần chạy heartbeat.
  - Giữ ngắn để tránh tiêu tốn token.

- `BOOT.md`
  - Checklist khởi động tùy chọn được thực thi khi gateway khởi động lại khi các hook nội bộ được bật.
  - Giữ ngắn; dùng công cụ message cho các gửi ra ngoài.

- `BOOTSTRAP.md`
  - Nghi thức chạy lần đầu, một lần duy nhất.
  - Chỉ được tạo cho workspace hoàn toàn mới.
  - Xóa sau khi hoàn tất nghi thức.

- `memory/YYYY-MM-DD.md`
  - Nhật ký bộ nhớ hằng ngày (mỗi ngày một tệp).
  - Khuyến nghị đọc hôm nay + hôm qua khi bắt đầu phiên.

- `MEMORY.md` (tùy chọn)
  - Bộ nhớ dài hạn được tuyển chọn.
  - Chỉ tải trong phiên chính, riêng tư (không dùng cho ngữ cảnh chia sẻ/nhóm).

Xem [Memory](/concepts/memory) để biết quy trình làm việc và cơ chế xả bộ nhớ tự động.

- `skills/` (tùy chọn)
  - Skills theo workspace.
  - Ghi đè Skills được quản lý/đóng gói khi trùng tên.

- `canvas/` (tùy chọn)
  - Các tệp Canvas UI cho hiển thị node (ví dụ `canvas/index.html`).

If any bootstrap file is missing, OpenClaw injects a "missing file" marker into
the session and continues. Large bootstrap files are truncated when injected;
adjust the limit with `agents.defaults.bootstrapMaxChars` (default: 20000).
`openclaw setup` can recreate missing defaults without overwriting existing
files.

## Những gì KHÔNG nằm trong workspace

Chúng nằm dưới `~/.openclaw/` và KHÔNG nên được commit vào repo workspace:

- `~/.openclaw/openclaw.json` (cấu hình)
- `~/.openclaw/credentials/` (token OAuth, khóa API)
- `~/.openclaw/agents/<agentId>/sessions/` (bản ghi phiên + metadata)
- `~/.openclaw/skills/` (Skills được quản lý)

Nếu bạn cần di chuyển các phiên hoặc cấu hình, hãy sao chép chúng riêng và giữ
chúng ngoài hệ thống kiểm soát phiên bản.

## Sao lưu Git (khuyến nghị, riêng tư)

Treat the workspace as private memory. Put it in a **private** git repo so it is
backed up and recoverable.

Chạy các bước này trên máy nơi Gateway chạy (đó là nơi workspace tồn tại).

### 1. Khởi tạo repo

If git is installed, brand-new workspaces are initialized automatically. If this
workspace is not already a repo, run:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Thêm remote riêng tư (tùy chọn thân thiện cho người mới)

Tùy chọn A: GitHub web UI

1. Tạo một repository **riêng tư** mới trên GitHub.
2. Không khởi tạo với README (tránh xung đột merge).
3. Sao chép URL remote HTTPS.
4. Thêm remote và đẩy lên:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Tùy chọn B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Tùy chọn C: GitLab web UI

1. Tạo một repository **riêng tư** mới trên GitLab.
2. Không khởi tạo với README (tránh xung đột merge).
3. Sao chép URL remote HTTPS.
4. Thêm remote và đẩy lên:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Cập nhật định kỳ

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Không commit bí mật

Ngay cả trong repo riêng tư, hãy tránh lưu bí mật trong workspace:

- Khóa API, token OAuth, mật khẩu hoặc thông tin xác thực riêng tư.
- Bất cứ thứ gì dưới `~/.openclaw/`.
- Bản dump thô của các cuộc trò chuyện hoặc tệp đính kèm nhạy cảm.

Nếu buộc phải lưu tham chiếu nhạy cảm, hãy dùng placeholder và giữ bí mật thật ở
nơi khác (trình quản lý mật khẩu, biến môi trường hoặc `~/.openclaw/`).

Gợi ý starter cho `.gitignore`:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Di chuyển workspace sang máy mới

1. Clone repo tới đường dẫn mong muốn (mặc định `~/.openclaw/workspace`).
2. Đặt `agents.defaults.workspace` trỏ tới đường dẫn đó trong `~/.openclaw/openclaw.json`.
3. Chạy `openclaw setup --workspace <path>` để khởi tạo các tệp còn thiếu.
4. Nếu cần các phiên, sao chép `~/.openclaw/agents/<agentId>/sessions/` từ
   máy cũ một cách riêng biệt.

## Ghi chú nâng cao

- Các tệp trống sẽ bị bỏ qua. See
  [Channel routing](/channels/channel-routing) for routing configuration.
- Nếu `agents.defaults.sandbox` được bật, các phiên không phải chính có thể dùng workspace
  sandbox theo từng phiên dưới `agents.defaults.sandbox.workspaceRoot`.
