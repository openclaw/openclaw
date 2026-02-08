---
summary: "Kế hoạch: một SDK plugin + runtime gọn gàng cho tất cả các connector nhắn tin"
read_when:
  - Xác định hoặc tái cấu trúc kiến trúc plugin
  - Di chuyển các connector kênh sang SDK/runtime plugin
title: "Tái cấu trúc SDK Plugin"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:05Z
---

# Kế hoạch tái cấu trúc SDK + Runtime cho Plugin

Mục tiêu: mọi connector nhắn tin đều là một plugin (đóng gói sẵn hoặc bên ngoài) sử dụng một API ổn định duy nhất.
Không plugin nào import trực tiếp từ `src/**`. Mọi phụ thuộc đều đi qua SDK hoặc runtime.

## Vì sao là bây giờ

- Các connector hiện tại trộn lẫn nhiều mô hình: import trực tiếp từ core, bridge chỉ cho bản dist, và helper tùy biến.
- Điều này làm việc nâng cấp trở nên mong manh và cản trở việc tạo bề mặt plugin bên ngoài gọn gàng.

## Kiến trúc mục tiêu (hai lớp)

### 1) SDK Plugin (thời điểm biên dịch, ổn định, có thể phát hành)

Phạm vi: kiểu dữ liệu, helper và tiện ích cấu hình. Không có trạng thái runtime, không có tác dụng phụ.

Nội dung (ví dụ):

- Kiểu dữ liệu: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Helper cấu hình: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Helper ghép cặp: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Helper hướng dẫn ban đầu: `promptChannelAccessConfig`, `addWildcardAllowFrom`, các kiểu onboarding.
- Helper tham số công cụ: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Helper liên kết tài liệu: `formatDocsLink`.

Phát hành:

- Phát hành dưới dạng `openclaw/plugin-sdk` (hoặc export từ core dưới `openclaw/plugin-sdk`).
- Theo semver với cam kết ổn định rõ ràng.

### 2) Runtime Plugin (bề mặt thực thi, được inject)

Phạm vi: mọi thứ chạm tới hành vi runtime của core.
Được truy cập thông qua `OpenClawPluginApi.runtime` để plugin không bao giờ import `src/**`.

Bề mặt đề xuất (tối thiểu nhưng đầy đủ):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

Ghi chú:

- Runtime là cách duy nhất để truy cập hành vi của core.
- SDK được cố ý giữ nhỏ và ổn định.
- Mỗi phương thức runtime ánh xạ tới một triển khai core hiện có (không trùng lặp).

## Kế hoạch di chuyển (theo giai đoạn, an toàn)

### Giai đoạn 0: khung ban đầu

- Giới thiệu `openclaw/plugin-sdk`.
- Thêm `api.runtime` vào `OpenClawPluginApi` với bề mặt như trên.
- Giữ các import hiện tại trong một khoảng chuyển tiếp (cảnh báo ngừng dùng).

### Giai đoạn 1: dọn dẹp bridge (rủi ro thấp)

- Thay thế `core-bridge.ts` theo từng extension bằng `api.runtime`.
- Di chuyển BlueBubbles, Zalo, Zalo Personal trước (đã khá gần).
- Loại bỏ mã bridge trùng lặp.

### Giai đoạn 2: plugin import trực tiếp nhẹ

- Di chuyển Matrix sang SDK + runtime.
- Xác thực logic onboarding, thư mục, mention trong nhóm.

### Giai đoạn 3: plugin import trực tiếp nặng

- Di chuyển MS Teams (tập helper runtime lớn nhất).
- Đảm bảo ngữ nghĩa trả lời/gõ phím khớp với hành vi hiện tại.

### Giai đoạn 4: plugin hóa iMessage

- Chuyển iMessage vào `extensions/imessage`.
- Thay thế các lời gọi core trực tiếp bằng `api.runtime`.
- Giữ nguyên khóa cấu hình, hành vi CLI và tài liệu.

### Giai đoạn 5: cưỡng chế

- Thêm quy tắc lint / kiểm tra CI: không import `extensions/**` từ `src/**`.
- Thêm kiểm tra tương thích SDK/phiên bản plugin (runtime + semver SDK).

## Tương thích và phiên bản hóa

- SDK: semver, được phát hành, thay đổi có tài liệu.
- Runtime: được version theo mỗi bản phát hành core. Thêm `api.runtime.version`.
- Plugin khai báo phạm vi runtime yêu cầu (ví dụ: `openclawRuntime: ">=2026.2.0"`).

## Chiến lược kiểm thử

- Unit test ở mức adapter (các hàm runtime được chạy với triển khai core thật).
- Golden test cho từng plugin: đảm bảo không lệch hành vi (định tuyến, ghép cặp, allowlist, chặn mention).
- Một plugin mẫu end-to-end duy nhất dùng trong CI (cài đặt + chạy + smoke).

## Câu hỏi mở

- Nên đặt các kiểu SDK ở đâu: package riêng hay export từ core?
- Phân phối kiểu runtime: trong SDK (chỉ kiểu) hay trong core?
- Cách expose liên kết tài liệu cho plugin đóng gói sẵn so với plugin bên ngoài?
- Có cho phép import core trực tiếp ở mức hạn chế cho plugin trong repo trong giai đoạn chuyển tiếp không?

## Tiêu chí thành công

- Tất cả connector kênh đều là plugin sử dụng SDK + runtime.
- Không còn import `extensions/**` từ `src/**`.
- Mẫu connector mới chỉ phụ thuộc vào SDK + runtime.
- Plugin bên ngoài có thể được phát triển và cập nhật mà không cần truy cập mã nguồn core.

Tài liệu liên quan: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
