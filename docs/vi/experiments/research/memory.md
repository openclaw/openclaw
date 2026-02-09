---
summary: "Ghi chú nghiên cứu: hệ thống bộ nhớ offline cho workspace Clawd (Markdown làm nguồn sự thật + chỉ mục dẫn xuất)"
read_when:
  - Thiết kế bộ nhớ workspace (~/.openclaw/workspace) vượt ra ngoài các nhật ký Markdown hằng ngày
  - Deciding: các ràng buộc về thời gian (“điều gì là đúng trong tháng 11 năm 2025?”)
  - Thêm khả năng hồi tưởng + phản tư offline (retain/recall/reflect)
title: "Nghiên cứu bộ nhớ Workspace"
---

# Workspace Memory v2 (offline): ghi chú nghiên cứu

Mục tiêu: workspace kiểu Clawd (`agents.defaults.workspace`, mặc định `~/.openclaw/workspace`) nơi “bộ nhớ” được lưu dưới dạng một tệp Markdown mỗi ngày (`memory/YYYY-MM-DD.md`) cùng với một tập nhỏ các tệp ổn định (ví dụ: `memory.md`, `SOUL.md`).

Tài liệu này đề xuất một kiến trúc bộ nhớ **ưu tiên offline** giữ Markdown làm nguồn sự thật chuẩn, có thể đọc và rà soát, đồng thời bổ sung **hồi tưởng có cấu trúc** (tìm kiếm, tóm tắt theo thực thể, cập nhật độ tin cậy) thông qua một chỉ mục dẫn xuất.

## Vì sao cần thay đổi?

Thiết lập hiện tại (mỗi ngày một tệp) rất phù hợp cho:

- ghi chép kiểu “append-only”
- chỉnh sửa thủ công
- độ bền + khả năng kiểm toán dựa trên git
- ghi nhận nhanh, ít ma sát (“cứ viết xuống”)

Nhưng nó yếu ở:

- truy xuất cần độ nhớ cao (“chúng ta đã quyết định gì về X?”, “lần trước thử Y khi nào?”)
- trả lời theo thực thể (“kể tôi nghe về Alice / The Castle / warelay”) mà không phải đọc lại nhiều tệp
- sự ổn định của ý kiến/sở thích (và bằng chứng khi thay đổi)
- các ràng buộc thời gian (“điều gì đúng vào tháng 11 năm 2025?”) và giải quyết xung đột

## Mục tiêu thiết kế

- **Offline**: hoạt động không cần mạng; chạy trên laptop/Castle; không phụ thuộc cloud.
- **Có thể giải thích**: các mục được truy xuất phải quy được nguồn (tệp + vị trí) và tách bạch khỏi suy luận.
- **Ít nghi thức**: ghi nhật ký hằng ngày vẫn là Markdown, không cần schema nặng.
- **Tăng dần**: v1 hữu ích chỉ với FTS; semantic/vector và đồ thị là nâng cấp tùy chọn.
- **Thân thiện với tác tử**: giúp “hồi tưởng trong giới hạn token” dễ dàng (trả về các gói sự kiện nhỏ).

## Mô hình ngôi sao bắc (Hindsight × Letta)

Hai thành phần cần kết hợp:

1. **Vòng điều khiển kiểu Letta/MemGPT**

- giữ một “lõi” nhỏ luôn có trong ngữ cảnh (persona + các sự kiện then chốt về người dùng)
- mọi thứ khác nằm ngoài ngữ cảnh và được truy xuất qua công cụ
- ghi bộ nhớ là các lệnh công cụ tường minh (append/replace/insert), được lưu bền vững, rồi được đưa lại vào lượt kế tiếp

2. **Nền tảng bộ nhớ kiểu Hindsight**

- tách biệt cái được quan sát vs cái được tin vs cái được tóm tắt
- hỗ trợ retain/recall/reflect
- ý kiến có độ tin cậy và có thể tiến hóa theo bằng chứng
- truy xuất theo thực thể + truy vấn theo thời gian (kể cả khi chưa có đồ thị tri thức đầy đủ)

## Kiến trúc đề xuất (Markdown làm nguồn sự thật + chỉ mục dẫn xuất)

### Kho chuẩn (thân thiện với git)

Giữ `~/.openclaw/workspace` làm bộ nhớ chuẩn, dễ đọc cho con người.

Bố cục workspace gợi ý:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Ghi chú:

- Không cần biến nó thành JSON. Không cần chuyển nó thành JSON.
- Các tệp `bank/` là **được tuyển chọn**, do các job phản tư tạo ra, và vẫn có thể chỉnh sửa thủ công.
- `memory.md` giữ ở mức “nhỏ + mang tính lõi”: những thứ bạn muốn Clawd thấy trong mỗi phiên.

### Kho dẫn xuất (hồi tưởng cho máy)

Thêm một chỉ mục dẫn xuất dưới workspace (không nhất thiết theo dõi bằng git):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Hậu thuẫn bởi:

- schema SQLite cho facts + liên kết thực thể + metadata ý kiến
- SQLite **FTS5** cho hồi tưởng từ vựng (nhanh, gọn, offline)
- bảng embeddings tùy chọn cho hồi tưởng ngữ nghĩa (vẫn offline)

Chỉ mục này luôn **có thể tái dựng từ Markdown**.

## Retain / Recall / Reflect (vòng lặp vận hành)

### Retain: chuẩn hóa nhật ký ngày thành “facts”

Insight then chốt của Hindsight áp dụng ở đây: lưu **các fact mang tính tường thuật, tự đủ**, không phải mảnh vụn nhỏ.

Quy tắc thực tế cho `memory/YYYY-MM-DD.md`:

- cuối ngày (hoặc trong ngày), thêm một mục `## Retain` với 2–5 gạch đầu dòng:
  - mang tính tường thuật (giữ được ngữ cảnh xuyên lượt)
  - tự đủ (đọc riêng vẫn hiểu)
  - được gắn thẻ loại + đề cập thực thể

Ví dụ:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Phân tích tối thiểu:

- Tiền tố loại: `W` (thế giới), `B` (trải nghiệm/tiểu sử), `O` (ý kiến), `S` (quan sát/tóm tắt; thường được tạo tự động)
- Thực thể: `@Peter`, `@warelay`, v.v. (slug ánh xạ tới `bank/entities/*.md`)
- Độ tin cậy ý kiến: `O(c=0.0..1.0)` tùy chọn

Nếu bạn không muốn tác giả phải nghĩ nhiều: job phản tư có thể suy ra các gạch đầu dòng này từ phần còn lại của nhật ký, nhưng có một mục `## Retain` tường minh là “đòn bẩy chất lượng” dễ nhất.

### Recall: truy vấn trên chỉ mục dẫn xuất

Recall nên hỗ trợ:

- **từ vựng**: “tìm thuật ngữ / tên / lệnh chính xác” (FTS5)
- **theo thực thể**: “kể tôi nghe về X” (trang thực thể + các fact liên kết thực thể)
- **theo thời gian**: “điều gì xảy ra quanh 27/11” / “kể từ tuần trước”
- (kèm theo sự tự tin + bằng chứng) OpenClaw hỗ trợ OAuth và API key cho các nhà cung cấp model.

Định dạng trả về nên thân thiện với tác tử và có trích dẫn nguồn:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (ngày nguồn, hoặc khoảng thời gian trích xuất nếu có)
- `entities` (`["Peter","warelay"]`)
- `content` (fact tường thuật)
- `source` (`memory/2025-11-27.md#L12` v.v.)

### Reflect: tạo trang ổn định + cập nhật niềm tin

Phản tư là một job theo lịch (hằng ngày hoặc nhịp `ultrathink`) để:

- cập nhật `bank/entities/*.md` từ các fact gần đây (tóm tắt theo thực thể)
- cập nhật độ tin cậy `bank/opinions.md` dựa trên củng cố/mâu thuẫn
- tùy chọn đề xuất chỉnh sửa `memory.md` (các fact “mang tính lõi” bền vững)

Tiến hóa ý kiến (đơn giản, có thể giải thích):

- mỗi ý kiến có:
  - phát biểu
  - độ tin cậy `c ∈ [0,1]`
  - last_updated
  - liên kết bằng chứng (ID fact ủng hộ + phản bác)
- khi có fact mới:
  - tìm các ý kiến ứng viên theo chồng lấn thực thể + độ tương đồng (FTS trước, embeddings sau)
  - cập nhật độ tin cậy theo các delta nhỏ; bước nhảy lớn cần mâu thuẫn mạnh + bằng chứng lặp lại

## Tích hợp CLI: độc lập vs tích hợp sâu

Khuyến nghị: **tích hợp sâu vào OpenClaw**, nhưng vẫn giữ một thư viện lõi có thể tách rời.

### Vì sao tích hợp vào OpenClaw?

- OpenClaw đã biết:
  - đường dẫn workspace (`agents.defaults.workspace`)
  - mô hình phiên + nhịp tim
  - mẫu logging + xử lý sự cố
- Bạn muốn chính tác tử gọi các công cụ:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Vì sao vẫn tách thư viện?

- giữ logic bộ nhớ có thể kiểm thử mà không cần gateway/runtime
- tái sử dụng trong các bối cảnh khác (script cục bộ, ứng dụng desktop tương lai, v.v.)

Hình dạng:
Bộ công cụ bộ nhớ dự kiến là một lớp CLI + thư viện nhỏ, nhưng đây mới chỉ là thăm dò.

## “S-Collide” / SuCo: khi nào nên dùng (nghiên cứu)

Nếu “S-Collide” ám chỉ **SuCo (Subspace Collision)**: đây là một phương pháp truy xuất ANN nhắm tới cân bằng tốt giữa recall/độ trễ bằng cách dùng các va chạm được học/cấu trúc trong các không gian con (bài báo: arXiv 2411.14754, 2024).

Quan điểm thực dụng cho `~/.openclaw/workspace`:

- **đừng bắt đầu** với SuCo.
- bắt đầu với SQLite FTS + (tùy chọn) embeddings đơn giản; bạn sẽ có phần lớn lợi ích UX ngay.
- chỉ cân nhắc SuCo/HNSW/ScaNN khi:
  - tập dữ liệu lớn (hàng chục/hàng trăm nghìn mảnh)
  - tìm kiếm embeddings brute-force trở nên quá chậm
  - chất lượng recall thực sự bị nghẽn bởi tìm kiếm từ vựng

Các lựa chọn thân thiện offline (độ phức tạp tăng dần):

- SQLite FTS5 + bộ lọc metadata (không ML)
- Embeddings + brute force (hiệu quả đáng ngạc nhiên khi số mảnh thấp)
- Chỉ mục HNSW (phổ biến, vững; cần binding thư viện)
- SuCo (cấp độ nghiên cứu; hấp dẫn nếu có triển khai vững để nhúng)

Câu hỏi mở:

- mô hình embedding offline **tốt nhất** cho “bộ nhớ trợ lý cá nhân” trên máy của bạn (laptop + desktop) là gì?
  - nếu đã có Ollama: embed bằng mô hình cục bộ; nếu không, đóng gói một mô hình embedding nhỏ trong toolchain.

## Bản pilot nhỏ nhất hữu ích

Nếu bạn muốn một phiên bản tối thiểu nhưng vẫn hữu ích:

- Thêm các trang thực thể `bank/` và một mục `## Retain` trong nhật ký ngày.
- Dùng SQLite FTS cho recall kèm trích dẫn (đường dẫn + số dòng).
- Chỉ thêm embeddings nếu chất lượng recall hoặc quy mô đòi hỏi.

## Tài liệu tham khảo

- Khái niệm Letta / MemGPT: “core memory blocks” + “archival memory” + bộ nhớ tự chỉnh sửa dựa trên công cụ.
- Báo cáo kỹ thuật Hindsight: “retain / recall / reflect”, bộ nhớ bốn mạng, trích xuất fact tường thuật, tiến hóa độ tin cậy ý kiến.
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” cho truy xuất láng giềng gần đúng.
