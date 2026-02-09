---
summary: "Danh sách kiểm tra phát hành từng bước cho npm + ứng dụng macOS"
read_when:
  - Phát hành một bản npm mới
  - Phát hành một bản ứng dụng macOS mới
  - Xác minh metadata trước khi xuất bản
---

# Danh sách kiểm tra phát hành (npm + macOS)

.apiKey\`) có thể xuất các key sang env của tiến trình skill. 6. Giữ working tree sạch trước khi gắn thẻ/phát hành.

## Kích hoạt từ operator

Khi operator nói “release”, ngay lập tức thực hiện preflight này (không hỏi thêm trừ khi bị chặn):

- Đọc tài liệu này và `docs/platforms/mac/release.md`.
- Nạp biến môi trường từ `~/.profile` và xác nhận `SPARKLE_PRIVATE_KEY_FILE` + các biến App Store Connect đã được thiết lập (SPARKLE_PRIVATE_KEY_FILE nên nằm trong `~/.profile`).
- Dùng khóa Sparkle từ `~/Library/CloudStorage/Dropbox/Backup/Sparkle` nếu cần.

1. **Phiên bản & metadata**

- [ ] Tăng phiên bản `package.json` (ví dụ: `2026.1.29`).
- [ ] Chạy `pnpm plugins:sync` để căn chỉnh phiên bản các gói extension + changelog.
- [ ] Cập nhật chuỗi CLI/phiên bản: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) và user agent Baileys trong [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Xác nhận metadata của package (name, description, repository, keywords, license) và ánh xạ `bin` trỏ tới [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) cho `openclaw`.
- [ ] Nếu dependencies thay đổi, chạy `pnpm install` để `pnpm-lock.yaml` được cập nhật.

2. **Build & artifacts**

- [ ] Nếu input A2UI thay đổi, chạy `pnpm canvas:a2ui:bundle` và commit mọi cập nhật cho [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (tái tạo `dist/`).
- [ ] Xác minh gói npm `files` bao gồm tất cả các thư mục `dist/*` cần thiết (đặc biệt là `dist/node-host/**` và `dist/acp/**` cho node headless + ACP CLI).
- [ ] Xác nhận `dist/build-info.json` tồn tại và chứa hash `commit` như mong đợi (banner CLI dùng giá trị này cho các cài đặt npm).
- [ ] Tùy chọn: `npm pack --pack-destination /tmp` sau khi build; kiểm tra nội dung tarball và giữ sẵn cho GitHub release ( **không** commit).

3. **Changelog & tài liệu**

- [ ] Cập nhật `CHANGELOG.md` với các điểm nổi bật hướng tới người dùng (tạo file nếu chưa có); giữ các mục sắp xếp giảm dần theo phiên bản.
- [ ] Đảm bảo ví dụ/flag trong README khớp với hành vi CLI hiện tại (đặc biệt là lệnh hoặc tùy chọn mới).

4. **Xác thực**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (hoặc `pnpm test:coverage` nếu cần đầu ra coverage)
- [ ] `pnpm release:check` (xác minh nội dung npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (kiểm tra smoke cài đặt Docker, đường nhanh; bắt buộc trước khi phát hành)
  - Nếu bản npm phát hành ngay trước đó được biết là lỗi, đặt `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` hoặc `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` cho bước preinstall.
- [ ] (Tùy chọn) Smoke installer đầy đủ (thêm non-root + độ phủ CLI): `pnpm test:install:smoke`
- [ ] (Tùy chọn) Installer E2E (Docker, chạy `curl -fsSL https://openclaw.ai/install.sh | bash`, onboarding, sau đó chạy các lệnh tool thật):
  - `pnpm test:install:e2e:openai` (yêu cầu `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (yêu cầu `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (yêu cầu cả hai khóa; chạy cả hai provider)
- [ ] (Tùy chọn) Kiểm tra nhanh web gateway nếu thay đổi của bạn ảnh hưởng đến luồng gửi/nhận.

5. **Ứng dụng macOS (Sparkle)**

- [ ] Build + ký ứng dụng macOS, sau đó nén zip để phân phối.
- [ ] Tạo appcast Sparkle (ghi chú HTML qua [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) và cập nhật `appcast.xml`.
- [ ] Giữ file zip ứng dụng (và zip dSYM tùy chọn) sẵn sàng để đính kèm vào GitHub release.
- [ ] Làm theo [macOS release](/platforms/mac/release) để biết chính xác các lệnh và biến môi trường cần thiết.
  - `APP_BUILD` phải là số + đơn điệu (không `-beta`) để Sparkle so sánh phiên bản đúng cách.
  - Nếu notarize, dùng hồ sơ keychain `openclaw-notary` được tạo từ các biến môi trường App Store Connect API (xem [macOS release](/platforms/mac/release)).

6. **Xuất bản (npm)**

- [ ] Xác nhận git status sạch; commit và push khi cần.
- [ ] `npm login` (xác minh 2FA) nếu cần.
- [ ] `npm publish --access public` (dùng `--tag beta` cho bản pre-release).
- [ ] Xác minh registry: `npm view openclaw version`, `npm view openclaw dist-tags`, và `npx -y openclaw@X.Y.Z --version` (hoặc `--help`).

### Xử lý sự cố (ghi chú từ bản phát hành 2.0.0-beta2)

- 6. **npm pack/publish bị treo hoặc tạo tarball khổng lồ**: gói ứng dụng macOS trong `dist/OpenClaw.app` (và các zip phát hành) bị cuốn vào gói. Khắc phục bằng cách whitelist nội dung xuất bản qua `package.json` `files` (bao gồm các thư mục con dist, docs, skills; loại trừ app bundles). Xác nhận bằng `npm pack --dry-run` rằng `dist/OpenClaw.app` không được liệt kê.
- **npm auth web lặp cho dist-tags**: dùng xác thực legacy để nhận prompt OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **Xác minh `npx` thất bại với `ECOMPROMISED: Lock compromised`**: thử lại với cache mới:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Cần trỏ lại tag sau khi sửa muộn**: force-update và push tag, sau đó đảm bảo các asset của GitHub release vẫn khớp:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub release + appcast**

- [ ] Gắn thẻ và push: `git tag vX.Y.Z && git push origin vX.Y.Z` (hoặc `git push --tags`).
- [ ] Tạo/làm mới GitHub release cho `vX.Y.Z` với **tiêu đề `openclaw X.Y.Z`** (không chỉ là tag); phần nội dung phải bao gồm **đầy đủ** mục changelog cho phiên bản đó (Highlights + Changes + Fixes), hiển thị inline (không chỉ link trần), và **không được lặp lại tiêu đề trong phần nội dung**.
- [ ] Đính kèm artifact: tarball `npm pack` (tùy chọn), `OpenClaw-X.Y.Z.zip`, và `OpenClaw-X.Y.Z.dSYM.zip` (nếu có).
- [ ] Commit `appcast.xml` đã cập nhật và push (Sparkle lấy feed từ main).
- [ ] Từ một thư mục tạm sạch (không có `package.json`), chạy `npx -y openclaw@X.Y.Z send --help` để xác nhận cài đặt/entrypoint CLI hoạt động.
- [ ] Thông báo/chia sẻ ghi chú phát hành.

## Phạm vi xuất bản plugin (npm)

Chúng tôi chỉ xuất bản **các plugin npm hiện có** dưới scope `@openclaw/*`. 10. Các plugin được đóng gói
mà không có trên npm sẽ **chỉ tồn tại trong cây đĩa** (vẫn được phát hành trong
`extensions/**`).

Quy trình để suy ra danh sách:

1. `npm search @openclaw --json` và ghi lại tên các package.
2. So sánh với tên trong `extensions/*/package.json`.
3. Chỉ xuất bản **phần giao** (đã có trên npm).

Danh sách plugin npm hiện tại (cập nhật khi cần):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

Ghi chú phát hành cũng phải nêu rõ **các plugin bundle tùy chọn mới** **không bật mặc định** (ví dụ: `tlon`).
