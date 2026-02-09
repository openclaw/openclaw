---
summary: "Chụp camera (node iOS + ứng dụng macOS) để tác tử sử dụng: ảnh (jpg) và clip video ngắn (mp4)"
read_when:
  - Thêm hoặc chỉnh sửa chụp camera trên node iOS hoặc macOS
  - Mở rộng các quy trình MEDIA tệp tạm cho tác tử truy cập
title: "Chụp Camera"
---

# Chụp camera (tác tử)

OpenClaw hỗ trợ **chụp camera** cho các quy trình làm việc của tác tử:

- **Node iOS** (ghép cặp qua Gateway): chụp **ảnh** (`jpg`) hoặc **clip video ngắn** (`mp4`, có thể kèm âm thanh) qua `node.invoke`.
- **Node Android** (ghép cặp qua Gateway): chụp **ảnh** (`jpg`) hoặc **clip video ngắn** (`mp4`, có thể kèm âm thanh) qua `node.invoke`.
- **Ứng dụng macOS** (node qua Gateway): chụp **ảnh** (`jpg`) hoặc **clip video ngắn** (`mp4`, có thể kèm âm thanh) qua `node.invoke`.

Mọi quyền truy cập camera đều được kiểm soát bởi **các cài đặt do người dùng quản lý**.

## Node iOS

### Cài đặt người dùng (mặc định bật)

- Tab Cài đặt iOS → **Camera** → **Allow Camera** (`camera.enabled`)
  - Mặc định: **bật** (thiếu khóa được xem là đã bật).
  - Khi tắt: các lệnh `camera.*` trả về `CAMERA_DISABLED`.

### Lệnh (qua Gateway `node.invoke`)

- `camera.list`
  - Payload phản hồi:
    - `devices`: mảng `{ id, name, position, deviceType }`

- `camera.snap`
  - Tham số:
    - `facing`: `front|back` (mặc định: `front`)
    - `maxWidth`: number (tùy chọn; mặc định `1600` trên node iOS)
    - `quality`: `0..1` (tùy chọn; mặc định `0.9`)
    - `format`: hiện tại `jpg`
    - `delayMs`: number (tùy chọn; mặc định `0`)
    - `deviceId`: string (tùy chọn; từ `camera.list`)
  - Payload phản hồi:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Bảo vệ payload: ảnh được nén lại để giữ payload base64 dưới 5 MB.

- `camera.clip`
  - Tham số:
    - `facing`: `front|back` (mặc định: `front`)
    - `durationMs`: number (mặc định `3000`, giới hạn tối đa `60000`)
    - `includeAudio`: boolean (mặc định `true`)
    - `format`: hiện tại `mp4`
    - `deviceId`: string (tùy chọn; từ `camera.list`)
  - Payload phản hồi:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Yêu cầu chạy tiền cảnh

Like `canvas.*`, the iOS node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### Trợ giúp CLI (tệp tạm + MEDIA)

Cách dễ nhất để lấy tệp đính kèm là qua trợ giúp CLI, công cụ này ghi media đã giải mã vào một tệp tạm và in ra `MEDIA:<path>`.

Ví dụ:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Ghi chú:

- `nodes camera snap` mặc định là **cả hai** hướng camera để tác tử có đủ hai góc nhìn.
- Các tệp đầu ra là tạm thời (trong thư mục temp của hệ điều hành) trừ khi bạn tự xây dựng wrapper riêng.

## Node Android

### Cài đặt người dùng Android (mặc định bật)

- Trang Cài đặt Android → **Camera** → **Allow Camera** (`camera.enabled`)
  - Mặc định: **bật** (thiếu khóa được xem là đã bật).
  - Khi tắt: các lệnh `camera.*` trả về `CAMERA_DISABLED`.

### Quyền

- Android yêu cầu quyền runtime:
  - `CAMERA` cho cả `camera.snap` và `camera.clip`.
  - `RECORD_AUDIO` cho `camera.clip` khi `includeAudio=true`.

Nếu thiếu quyền, ứng dụng sẽ nhắc khi có thể; nếu bị từ chối, các yêu cầu `camera.*` sẽ thất bại với lỗi
`*_PERMISSION_REQUIRED`.

### Yêu cầu chạy tiền cảnh trên Android

Like `canvas.*`, the Android node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### Bảo vệ payload

Ảnh được nén lại để giữ payload base64 dưới 5 MB.

## Ứng dụng macOS

### Cài đặt người dùng (mặc định tắt)

Ứng dụng đồng hành macOS cung cấp một ô chọn:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - Mặc định: **tắt**
  - Khi tắt: các yêu cầu camera trả về “Camera disabled by user”.

### Trợ giúp CLI (gọi node)

Sử dụng CLI chính `openclaw` để gọi các lệnh camera trên node macOS.

Ví dụ:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Ghi chú:

- `openclaw nodes camera snap` mặc định là `maxWidth=1600` trừ khi được ghi đè.
- Trên macOS, `camera.snap` chờ `delayMs` (mặc định 2000ms) sau khi làm ấm/ổn định phơi sáng trước khi chụp.
- Payload ảnh được nén lại để giữ base64 dưới 5 MB.

## An toàn + giới hạn thực tế

- Quyền truy cập camera và micro sẽ kích hoạt các hộp thoại xin quyền tiêu chuẩn của hệ điều hành (và yêu cầu chuỗi mô tả sử dụng trong Info.plist).
- Clip video bị giới hạn (hiện tại `<= 60s`) để tránh payload node quá lớn (độ dư base64 + giới hạn thông điệp).

## Video màn hình macOS (cấp hệ điều hành)

Đối với video _màn hình_ (không phải camera), hãy dùng ứng dụng đồng hành macOS:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Ghi chú:

- Yêu cầu quyền **Screen Recording** của macOS (TCC).
