---
summary: "Các kênh stable, beta và dev: ngữ nghĩa, chuyển đổi và gắn thẻ"
read_when:
  - "Bạn muốn chuyển giữa stable/beta/dev"
  - "Bạn đang gắn thẻ hoặc phát hành prerelease"
title: "Các kênh phát triển"
x-i18n:
  source_path: install/development-channels.md
  source_hash: 2b01219b7e705044
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:16Z
---

# Các kênh phát triển

Cập nhật lần cuối: 2026-01-21

OpenClaw cung cấp ba kênh cập nhật:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (các bản build đang được thử nghiệm).
- **dev**: đầu nhánh luôn thay đổi của `main` (git). npm dist-tag: `dev` (khi được phát hành).

Chúng tôi phát hành các bản build lên **beta**, kiểm thử chúng, sau đó **thăng cấp một bản build đã được thẩm định lên `latest`**
mà không thay đổi số phiên bản — dist-tag là nguồn chân lý cho các cài đặt npm.

## Chuyển đổi kênh

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` checkout thẻ phù hợp mới nhất (thường là cùng một thẻ).
- `dev` chuyển sang `main` và rebase theo upstream.

Cài đặt toàn cục bằng npm/pnpm:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Thao tác này cập nhật thông qua npm dist-tag tương ứng (`latest`, `beta`, `dev`).

Khi bạn **chủ động** chuyển kênh bằng `--channel`, OpenClaw cũng căn chỉnh
phương thức cài đặt:

- `dev` đảm bảo một git checkout (mặc định `~/openclaw`, có thể ghi đè bằng `OPENCLAW_GIT_DIR`),
  cập nhật nó và cài đặt CLI toàn cục từ checkout đó.
- `stable`/`beta` cài đặt từ npm bằng dist-tag tương ứng.

Mẹo: nếu bạn muốn dùng song song stable + dev, hãy giữ hai bản clone và trỏ gateway của bạn tới bản stable.

## Plugin và kênh

Khi bạn chuyển kênh bằng `openclaw update`, OpenClaw cũng đồng bộ nguồn plugin:

- `dev` ưu tiên các plugin đi kèm từ git checkout.
- `stable` và `beta` khôi phục các gói plugin đã cài từ npm.

## Thực hành tốt nhất khi gắn thẻ

- Gắn thẻ các bản phát hành mà bạn muốn git checkout trỏ tới (`vYYYY.M.D` hoặc `vYYYY.M.D-<patch>`).
- Giữ thẻ bất biến: không bao giờ di chuyển hoặc tái sử dụng một thẻ.
- npm dist-tag vẫn là nguồn chân lý cho các cài đặt npm:
  - `latest` → stable
  - `beta` → bản build ứng viên
  - `dev` → ảnh chụp main (tùy chọn)

## Khả dụng của ứng dụng macOS

Các bản build beta và dev có thể **không** bao gồm bản phát hành ứng dụng macOS. Điều đó là bình thường:

- Git tag và npm dist-tag vẫn có thể được phát hành.
- Nêu rõ “không có bản build macOS cho bản beta này” trong ghi chú phát hành hoặc changelog.
