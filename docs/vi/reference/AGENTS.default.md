---
summary: "Hướng dẫn mặc định cho tác tử OpenClaw và danh sách Skills cho thiết lập trợ lý cá nhân"
read_when:
  - Bắt đầu một phiên tác tử OpenClaw mới
  - Bật hoặc kiểm tra các Skills mặc định
---

# AGENTS.md — Trợ lý cá nhân OpenClaw (mặc định)

## Lần chạy đầu tiên (khuyến nghị)

**discord** — Các hành động Discord: react, stickers, polls. 4. Mặc định: `~/.openclaw/workspace` (có thể cấu hình qua `agents.defaults.workspace`).

1. Tạo workspace (nếu chưa tồn tại):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Sao chép các mẫu workspace mặc định vào workspace:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Tùy chọn: nếu bạn muốn danh sách Skills cho trợ lý cá nhân, hãy thay thế AGENTS.md bằng tệp này:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Tùy chọn: chọn một workspace khác bằng cách đặt `agents.defaults.workspace` (hỗ trợ `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Mặc định an toàn

- Không đổ toàn bộ thư mục hoặc bí mật vào chat.
- Không chạy các lệnh mang tính phá hủy trừ khi được yêu cầu rõ ràng.
- Không gửi trả lời từng phần/streaming tới các bề mặt nhắn tin bên ngoài (chỉ gửi trả lời cuối cùng).

## Bắt đầu phiên (bắt buộc)

- Đọc `SOUL.md`, `USER.md`, `memory.md`, và hôm nay + hôm qua trong `memory/`.
- Thực hiện việc này trước khi phản hồi.

## Linh hồn (bắt buộc)

- `SOUL.md` định nghĩa danh tính, giọng điệu và ranh giới. Keep it current.
- Nếu bạn thay đổi `SOUL.md`, hãy cho người dùng biết.
- Mỗi phiên bạn là một thực thể mới; tính liên tục nằm trong các tệp này.

## Không gian dùng chung (khuyến nghị)

- Bạn không phải là tiếng nói của người dùng; hãy cẩn trọng trong các nhóm chat hoặc kênh công khai.
- Không chia sẻ dữ liệu riêng tư, thông tin liên hệ hoặc ghi chú nội bộ.

## Hệ thống bộ nhớ (khuyến nghị)

- Nhật ký hằng ngày: `memory/YYYY-MM-DD.md` (tạo `memory/` nếu cần).
- Bộ nhớ dài hạn: `memory.md` cho các факт bền vững, sở thích và quyết định.
- Khi bắt đầu phiên, đọc hôm nay + hôm qua + `memory.md` nếu có.
- Ghi lại: quyết định, sở thích, ràng buộc, các vòng việc còn mở.
- Tránh lưu bí mật trừ khi được yêu cầu rõ ràng.

## Công cụ & Skills

- Công cụ nằm trong các skills; hãy làm theo `SKILL.md` của từng skill khi cần.
- Giữ các ghi chú theo môi trường trong `TOOLS.md` (Notes for Skills).

## Mẹo sao lưu (khuyến nghị)

Nếu bạn coi workspace này là “bộ nhớ” của Clawd, hãy biến nó thành một repo git (tốt nhất là riêng tư) để `AGENTS.md` và các tệp bộ nhớ của bạn được sao lưu.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw làm gì

- Chạy gateway WhatsApp + tác tử lập trình Pi để trợ lý có thể đọc/ghi chat, lấy ngữ cảnh và chạy Skills thông qua máy Mac chủ.
- Ứng dụng macOS quản lý quyền (ghi màn hình, thông báo, micro) và cung cấp CLI `openclaw` thông qua binary đi kèm.
- Chat trực tiếp mặc định gộp vào phiên `main` của tác tử; các nhóm được giữ tách biệt như `agent:<agentId>:<channel>:group:<id>` (phòng/kênh: `agent:<agentId>:<channel>:channel:<id>`); heartbeat giữ cho các tác vụ nền hoạt động.

## Skills cốt lõi (bật trong Settings → Skills)

- **mcporter** — Runtime/CLI máy chủ công cụ để quản lý các backend skill bên ngoài.
- **Peekaboo** — Chụp ảnh màn hình macOS nhanh với phân tích thị giác AI tùy chọn.
- **camsnap** — Ghi khung hình, clip hoặc cảnh báo chuyển động từ camera an ninh RTSP/ONVIF.
- **oracle** — CLI tác tử sẵn sàng cho OpenAI với phát lại phiên và điều khiển trình duyệt.
- **eightctl** — Điều khiển giấc ngủ của bạn từ terminal.
- **imsg** — Gửi, đọc, stream iMessage & SMS.
- **wacli** — WhatsApp CLI: đồng bộ, tìm kiếm, gửi.
- **discord** — Discord actions: react, stickers, polls. Sử dụng mục tiêu `user:<id>` hoặc `channel:<id>` (id số thuần là mơ hồ).
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Trình phát Spotify trong terminal để tìm kiếm/xếp hàng/điều khiển phát.
- **sag** — Giọng nói ElevenLabs với UX kiểu macOS say; mặc định phát ra loa.
- **Sonos CLI** — Điều khiển loa Sonos (khám phá/trạng thái/phát/âm lượng/nhóm) từ script.
- **blucli** — Phát, nhóm và tự động hóa trình phát BluOS từ script.
- **OpenHue CLI** — Điều khiển đèn Philips Hue cho cảnh và tự động hóa.
- **OpenAI Whisper** — Chuyển giọng nói sang văn bản cục bộ cho ghi âm nhanh và transcript voicemail.
- **Gemini CLI** — Mô hình Google Gemini từ terminal cho hỏi đáp nhanh.
- **agent-tools** — Bộ tiện ích cho tự động hóa và script trợ giúp.

## Ghi chú sử dụng

- Ưu tiên CLI `openclaw` cho scripting; ứng dụng macOS xử lý quyền.
- Chạy cài đặt từ tab Skills; nút sẽ được ẩn nếu binary đã tồn tại.
- Giữ heartbeat bật để trợ lý có thể lên lịch nhắc nhở, theo dõi hộp thư đến và kích hoạt chụp camera.
- 2. Giao diện Canvas chạy toàn màn hình với các lớp phủ gốc. Tránh đặt các điều khiển quan trọng ở các cạnh trên-trái/trên-phải/dưới; thêm các lề (gutters) rõ ràng trong bố cục và đừng dựa vào safe-area insets.
- Với xác minh dựa trên trình duyệt, dùng `openclaw browser` (tab/trạng thái/ảnh chụp màn hình) với profile Chrome do OpenClaw quản lý.
- Để kiểm tra DOM, dùng `openclaw browser eval|query|dom|snapshot` (và `--json`/`--out` khi cần đầu ra cho máy).
- Đối với tương tác, dùng `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (click/type yêu cầu tham chiếu snapshot; dùng `evaluate` cho CSS selector).
