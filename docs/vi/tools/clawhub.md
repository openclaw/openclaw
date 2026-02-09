---
summary: "Hướng dẫn ClawHub: registry Skills công khai + quy trình làm việc với CLI"
read_when:
  - Giới thiệu ClawHub cho người dùng mới
  - Cài đặt, tìm kiếm hoặc phát hành Skills
  - Giải thích các cờ CLI của ClawHub và hành vi đồng bộ
title: "ClawHub"
---

# ClawHub

24. ClawHub là **registry kỹ năng công khai cho OpenClaw**. It is a free service: all skills are public, open, and visible to everyone for sharing and reuse. 26. Một kỹ năng chỉ là một thư mục với tệp `SKILL.md` (kèm theo các tệp văn bản hỗ trợ). You can browse skills in the web app or use the CLI to search, install, update, and publish skills.

Trang web: [clawhub.ai](https://clawhub.ai)

## ClawHub là gì

- Một registry công khai cho Skills của OpenClaw.
- Kho lưu trữ các gói Skill và metadata có phiên bản.
- Bề mặt khám phá cho tìm kiếm, thẻ và tín hiệu sử dụng.

## Cách hoạt động

1. Người dùng phát hành một gói Skill (tệp + metadata).
2. ClawHub lưu trữ gói, phân tích metadata và gán phiên bản.
3. Registry lập chỉ mục Skill để tìm kiếm và khám phá.
4. Người dùng duyệt, tải xuống và cài đặt Skills trong OpenClaw.

## Bạn có thể làm gì

- Phát hành Skills mới và phiên bản mới của Skills hiện có.
- Khám phá Skills theo tên, thẻ hoặc tìm kiếm.
- Tải xuống các gói Skill và kiểm tra nội dung tệp.
- Báo cáo các Skills có tính lạm dụng hoặc không an toàn.
- Nếu bạn là moderator, ẩn, bỏ ẩn, xóa hoặc cấm.

## Dành cho ai (thân thiện với người mới)

If you want to add new capabilities to your OpenClaw agent, ClawHub is the easiest way to find and install skills. 29. Bạn không cần biết backend hoạt động như thế nào. 30. Bạn có thể:

- Tìm kiếm Skills bằng ngôn ngữ tự nhiên.
- Cài đặt một Skill vào workspace của bạn.
- Cập nhật Skills sau này chỉ với một lệnh.
- Sao lưu Skills của chính bạn bằng cách phát hành chúng.

## Khởi động nhanh (không kỹ thuật)

1. Cài đặt CLI (xem phần tiếp theo).
2. Tìm kiếm thứ bạn cần:
   - `clawhub search "calendar"`
3. Cài đặt một Skill:
   - `clawhub install <skill-slug>`
4. Bắt đầu một phiên OpenClaw mới để nó nhận Skill mới.

## Cài đặt CLI

Chọn một:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Cách tích hợp với OpenClaw

44. Theo mặc định, CLI cài đặt các kỹ năng vào `./skills` dưới thư mục làm việc hiện tại của bạn. If a OpenClaw workspace is configured, `clawhub` falls back to that workspace unless you override `--workdir` (or `CLAWHUB_WORKDIR`). 33. OpenClaw tải các kỹ năng của workspace từ `<workspace>/skills` và sẽ nhận chúng ở phiên **tiếp theo**. 34. Nếu bạn đã sử dụng `~/.openclaw/skills` hoặc các kỹ năng đi kèm, kỹ năng của workspace sẽ được ưu tiên.

Để biết thêm chi tiết về cách Skills được tải, chia sẻ và kiểm soát, xem
[Skills](/tools/skills).

## Tổng quan hệ thống Skills

A skill is a versioned bundle of files that teaches OpenClaw how to perform a
specific task. Each publish creates a new version, and the registry keeps a
history of versions so users can audit changes.

Một Skill điển hình bao gồm:

- Một tệp `SKILL.md` với mô tả chính và cách dùng.
- Các cấu hình, script hoặc tệp hỗ trợ tùy chọn được Skill sử dụng.
- Metadata như thẻ, tóm tắt và yêu cầu cài đặt.

ClawHub sử dụng siêu dữ liệu để hỗ trợ khám phá và phơi bày an toàn các khả năng của kỹ năng.
Registry cũng theo dõi các tín hiệu sử dụng (chẳng hạn như sao và lượt tải) để cải thiện
xếp hạng và khả năng hiển thị.

## Dịch vụ cung cấp gì (tính năng)

- **Duyệt công khai** Skills và nội dung `SKILL.md` của chúng.
- **Tìm kiếm** được hỗ trợ bởi embeddings (tìm kiếm vector), không chỉ từ khóa.
- **Quản lý phiên bản** với semver, changelog và thẻ (bao gồm `latest`).
- **Tải xuống** dưới dạng zip theo từng phiên bản.
- **Sao và bình luận** cho phản hồi cộng đồng.
- **Công cụ kiểm duyệt** cho phê duyệt và kiểm tra.
- **API thân thiện với CLI** cho tự động hóa và scripting.

## Bảo mật và kiểm duyệt

39. ClawHub mặc định là mở. 40. Bất kỳ ai cũng có thể tải lên kỹ năng, nhưng tài khoản GitHub phải
    được tạo ít nhất một tuần để xuất bản. Điều này giúp làm chậm việc lạm dụng mà không chặn
    những người đóng góp hợp pháp.

Báo cáo và kiểm duyệt:

- Bất kỳ người dùng đã đăng nhập nào cũng có thể báo cáo một Skill.
- Lý do báo cáo là bắt buộc và được ghi nhận.
- Mỗi người dùng có thể có tối đa 20 báo cáo đang hoạt động cùng lúc.
- Skills có hơn 3 báo cáo duy nhất sẽ tự động bị ẩn theo mặc định.
- Moderator có thể xem Skills bị ẩn, bỏ ẩn, xóa hoặc cấm người dùng.
- Lạm dụng tính năng báo cáo có thể dẫn đến bị cấm tài khoản.

Bạn quan tâm đến việc trở thành người kiểm duyệt? 43. Hãy hỏi trong OpenClaw Discord và liên hệ với một
moderator hoặc maintainer.

## Lệnh và tham số CLI

Tùy chọn toàn cục (áp dụng cho tất cả lệnh):

- `--workdir <dir>`: Thư mục làm việc (mặc định: thư mục hiện tại; quay về workspace OpenClaw).
- `--dir <dir>`: Thư mục Skills, tương đối với workdir (mặc định: `skills`).
- `--site <url>`: URL cơ sở của trang (đăng nhập qua trình duyệt).
- `--registry <url>`: URL cơ sở của API registry.
- `--no-input`: Tắt prompt (không tương tác).
- `-V, --cli-version`: In phiên bản CLI.

Xác thực:

- `clawhub login` (luồng trình duyệt) hoặc `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Tùy chọn:

- `--token <token>`: Dán token API.
- `--label <label>`: Nhãn lưu cho token đăng nhập qua trình duyệt (mặc định: `CLI token`).
- `--no-browser`: Không mở trình duyệt (yêu cầu `--token`).

Tìm kiếm:

- `clawhub search "query"`
- `--limit <n>`: Số kết quả tối đa.

Cài đặt:

- `clawhub install <slug>`
- `--version <version>`: Cài đặt một phiên bản cụ thể.
- `--force`: Ghi đè nếu thư mục đã tồn tại.

Cập nhật:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Cập nhật lên một phiên bản cụ thể (chỉ một slug).
- `--force`: Ghi đè khi tệp cục bộ không khớp với bất kỳ phiên bản đã phát hành nào.

Danh sách:

- `clawhub list` (đọc `.clawhub/lock.json`)

Phát hành:

- `clawhub publish <path>`
- `--slug <slug>`: Slug của Skill.
- `--name <name>`: Tên hiển thị.
- `--version <version>`: Phiên bản semver.
- `--changelog <text>`: Văn bản changelog (có thể để trống).
- `--tags <tags>`: Thẻ phân tách bằng dấu phẩy (mặc định: `latest`).

Xóa/khôi phục (chỉ chủ sở hữu/admin):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Đồng bộ (quét Skills cục bộ + phát hành mới/cập nhật):

- `clawhub sync`
- `--root <dir...>`: Gốc quét bổ sung.
- `--all`: Tải lên mọi thứ mà không hỏi.
- `--dry-run`: Hiển thị những gì sẽ được tải lên.
- `--bump <type>`: `patch|minor|major` cho cập nhật (mặc định: `patch`).
- `--changelog <text>`: Changelog cho cập nhật không tương tác.
- `--tags <tags>`: Thẻ phân tách bằng dấu phẩy (mặc định: `latest`).
- `--concurrency <n>`: Kiểm tra registry (mặc định: 4).

## Quy trình làm việc phổ biến cho tác tử

### Tìm kiếm Skills

```bash
clawhub search "postgres backups"
```

### Tải xuống Skills mới

```bash
clawhub install my-skill-pack
```

### Cập nhật Skills đã cài đặt

```bash
clawhub update --all
```

### Sao lưu Skills của bạn (phát hành hoặc đồng bộ)

Với một thư mục Skill đơn lẻ:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Để quét và sao lưu nhiều Skills cùng lúc:

```bash
clawhub sync --all
```

## Chi tiết nâng cao (kỹ thuật)

### Phiên bản và thẻ

- Mỗi lần phát hành tạo ra một `SkillVersion` **semver** mới.
- Thẻ (như `latest`) trỏ tới một phiên bản; di chuyển thẻ cho phép bạn quay lui.
- Changelog được đính kèm theo từng phiên bản và có thể để trống khi đồng bộ hoặc phát hành cập nhật.

### Thay đổi cục bộ so với phiên bản registry

Các bản cập nhật so sánh nội dung kỹ năng cục bộ với các phiên bản trong registry bằng cách sử dụng băm nội dung. 45. Nếu các tệp cục bộ không khớp với bất kỳ phiên bản đã xuất bản nào, CLI sẽ hỏi trước khi ghi đè (hoặc yêu cầu `--force` trong các lần chạy không tương tác).

### Quét đồng bộ và gốc dự phòng

46. `clawhub sync` quét workdir hiện tại của bạn trước. 47. Nếu không tìm thấy kỹ năng nào, nó sẽ quay về các vị trí legacy đã biết (ví dụ `~/openclaw/skills` và `~/.openclaw/skills`). 48. Điều này được thiết kế để tìm các bản cài đặt kỹ năng cũ mà không cần thêm cờ.

### Lưu trữ và lockfile

- Các Skills đã cài đặt được ghi lại trong `.clawhub/lock.json` dưới workdir của bạn.
- Token xác thực được lưu trong tệp cấu hình CLI của ClawHub (ghi đè qua `CLAWHUB_CONFIG_PATH`).

### Telemetry (đếm lượt cài đặt)

49. Khi bạn chạy `clawhub sync` trong lúc đã đăng nhập, CLI gửi một snapshot tối thiểu để tính toán số lượt cài đặt. 50. Bạn có thể tắt hoàn toàn điều này:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Biến môi trường

- `CLAWHUB_SITE`: Ghi đè URL trang web.
- `CLAWHUB_REGISTRY`: Ghi đè URL API registry.
- `CLAWHUB_CONFIG_PATH`: Ghi đè nơi CLI lưu token/cấu hình.
- `CLAWHUB_WORKDIR`: Ghi đè workdir mặc định.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Tắt telemetry trên `sync`.
