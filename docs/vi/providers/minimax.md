---
summary: "Sử dụng MiniMax M2.1 trong OpenClaw"
read_when:
  - Bạn muốn dùng các mô hình MiniMax trong OpenClaw
  - Bạn cần hướng dẫn thiết lập MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax is an AI company that builds the **M2/M2.1** model family. 3. Bản phát hành hiện tại tập trung vào lập trình là **MiniMax M2.1** (23 tháng 12, 2025), được xây dựng cho các tác vụ phức tạp trong thế giới thực.

Nguồn: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Tổng quan mô hình (M2.1)

MiniMax nêu bật các cải tiến sau trong M2.1:

- **Lập trình đa ngôn ngữ** mạnh hơn (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- **Phát triển web/app** và chất lượng đầu ra thẩm mỹ tốt hơn (bao gồm mobile native).
- Xử lý **chỉ dẫn tổng hợp** được cải thiện cho các quy trình làm việc kiểu văn phòng, xây dựng trên tư duy đan xen và thực thi ràng buộc tích hợp.
- **Phản hồi ngắn gọn hơn** với mức sử dụng token thấp hơn và vòng lặp lặp lại nhanh hơn.
- Khả năng tương thích **framework tool/agent** và quản lý ngữ cảnh mạnh hơn (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Đầu ra **đối thoại và viết kỹ thuật** chất lượng cao hơn.

## MiniMax M2.1 so với MiniMax M2.1 Lightning

- **Tốc độ:** Lightning là biến thể “nhanh” trong tài liệu giá của MiniMax.
- **Chi phí:** Bảng giá cho thấy chi phí đầu vào giống nhau, nhưng Lightning có chi phí đầu ra cao hơn.
- 4. **Định tuyến gói lập trình:** Back-end Lightning không khả dụng trực tiếp trên gói lập trình MiniMax. 5. MiniMax tự động định tuyến hầu hết các yêu cầu tới Lightning, nhưng sẽ quay về back-end M2.1 thông thường khi lưu lượng tăng đột biến.

## Chọn cách thiết lập

### MiniMax OAuth (Coding Plan) — khuyến nghị

**Phù hợp nhất cho:** thiết lập nhanh với MiniMax Coding Plan qua OAuth, không cần khóa API.

Bật plugin OAuth đi kèm và xác thực:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Bạn sẽ được yêu cầu chọn endpoint:

- **Global** - Người dùng quốc tế (`api.minimax.io`)
- **CN** - Người dùng tại Trung Quốc (`api.minimaxi.com`)

Xem chi tiết tại [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth).

### MiniMax M2.1 (API key)

**Phù hợp nhất cho:** MiniMax hosted với API tương thích Anthropic.

Cấu hình qua CLI:

- Chạy `openclaw configure`
- Chọn **Model/auth**
- Chọn **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 làm dự phòng (Opus chính)

**Phù hợp nhất cho:** giữ Opus 4.6 làm chính, chuyển sang MiniMax M2.1 khi lỗi.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Tùy chọn: Local qua LM Studio (thủ công)

**Best for:** local inference with LM Studio.
We have seen strong results with MiniMax M2.1 on powerful hardware (e.g. a
desktop/server) using LM Studio's local server.

Cấu hình thủ công qua `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Cấu hình qua `openclaw configure`

Sử dụng trình hướng dẫn cấu hình tương tác để thiết lập MiniMax mà không cần chỉnh sửa JSON:

1. Chạy `openclaw configure`.
2. Chọn **Model/auth**.
3. Chọn **MiniMax M2.1**.
4. Chọn mô hình mặc định khi được nhắc.

## Tùy chọn cấu hình

- `models.providers.minimax.baseUrl`: ưu tiên `https://api.minimax.io/anthropic` (tương thích Anthropic); `https://api.minimax.io/v1` là tùy chọn cho payload tương thích OpenAI.
- `models.providers.minimax.api`: ưu tiên `anthropic-messages`; `openai-completions` là tùy chọn cho payload tương thích OpenAI.
- `models.providers.minimax.apiKey`: khóa API MiniMax (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: định nghĩa `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: đặt bí danh cho các mô hình bạn muốn trong allowlist.
- `models.mode`: giữ `merge` nếu bạn muốn thêm MiniMax cùng với các mô hình tích hợp sẵn.

## Ghi chú

- Tham chiếu mô hình là `minimax/<model>`.
- API sử dụng Coding Plan: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (yêu cầu khóa coding plan).
- Cập nhật giá trong `models.json` nếu bạn cần theo dõi chi phí chính xác.
- Liên kết giới thiệu cho MiniMax Coding Plan (giảm 10%): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Xem [/concepts/model-providers](/concepts/model-providers) để biết quy tắc nhà cung cấp.
- Dùng `openclaw models list` và `openclaw models set minimax/MiniMax-M2.1` để chuyển đổi.

## Xử lý sự cố

### “Unknown model: minimax/MiniMax-M2.1”

6. Điều này thường có nghĩa là **nhà cung cấp MiniMax chưa được cấu hình** (không có mục provider và không tìm thấy hồ sơ xác thực/env key MiniMax). A fix for this detection is in
   **2026.1.12** (unreleased at the time of writing). Fix by:

- Nâng cấp lên **2026.1.12** (hoặc chạy từ mã nguồn `main`), sau đó khởi động lại gateway.
- Chạy `openclaw configure` và chọn **MiniMax M2.1**, hoặc
- Thêm khối `models.providers.minimax` thủ công, hoặc
- Thiết lập `MINIMAX_API_KEY` (hoặc một hồ sơ xác thực MiniMax) để provider có thể được inject.

Đảm bảo id mô hình **phân biệt chữ hoa/thường**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Sau đó kiểm tra lại với:

```bash
openclaw models list
```
