---
summary: "ノードのペアリング、フォアグラウンド要件、権限、ツール失敗のトラブルシューティング"
read_when:
  - ノードは接続されているが、camera/canvas/screen/exec ツールが失敗する場合
  - ノードのペアリングと承認のメンタルモデルを理解する必要がある場合
title: "ノードのトラブルシューティング"
---

# ノードのトラブルシューティング

ステータス上でノードは表示されているが、ノードツールが失敗する場合は、このページを使用してください。

## コマンドラダー

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次に、ノード固有のチェックを実行します。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

正常な信号:

- ノードが接続され、役割 `node` に対してペアリングされています。
- `nodes describe` に、呼び出している機能が含まれています。
- 実行承認に、期待されるモード / 許可リストが表示されています。

## フォアグラウンド要件

`canvas.*`、`camera.*`、`screen.*` は、iOS/Android ノードではフォアグラウンド専用です。

簡易チェックと修正:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE` が表示される場合は、ノードアプリをフォアグラウンドにして再試行してください。

## 権限マトリクス

| Capability                  | iOS                | Android                      | macOS ノードアプリ     | 典型的な失敗コード                      |
| --------------------------- | ------------------ | ---------------------------- | ---------------- | ------------------------------ |
| `camera.snap`、`camera.clip` | カメラ（クリップ音声用にマイク）   | カメラ（クリップ音声用にマイク）             | カメラ（クリップ音声用にマイク） | `*_PERMISSION_REQUIRED`        |
| `screen.record`             | 画面収録（マイクは任意）       | 画面キャプチャのプロンプト（マイクは任意）        | 画面収録             | `*_PERMISSION_REQUIRED`        |
| `location.get`              | 使用中または常に許可（モードに依存） | モードに基づくフォアグラウンド/バックグラウンド位置情報 | 位置情報の権限          | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                | 該当なし（ノードホストのパス）    | 該当なし（ノードホストのパス）              | 実行承認が必要          | `SYSTEM_RUN_DENIED`            |

## ペアリングと承認の違い

これらは異なるゲートです。

1. **デバイスのペアリング**: このノードはゲートウェイに接続できますか。
2. **実行承認**: このノードは特定のシェルコマンドを実行できますか。

簡易チェック:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

ペアリングがない場合は、最初にノードデバイスを承認してください。
ペアリングは問題なく、 `system.run` が失敗した場合、 exec approvals/allowlist を修正します。

## 一般的なノードのエラーコード

- `NODE_BACKGROUND_UNAVAILABLE` → アプリがバックグラウンドです。フォアグラウンドにしてください。
- `CAMERA_DISABLED` → ノード設定でカメラのトグルが無効です。
- `*_PERMISSION_REQUIRED` → OS の権限が不足または拒否されています。
- `LOCATION_DISABLED` → 位置情報モードがオフです。
- `LOCATION_PERMISSION_REQUIRED` → 要求された位置情報モードが付与されていません。
- `LOCATION_BACKGROUND_UNAVAILABLE` → アプリがバックグラウンドですが、「使用中のみ」の権限しかありません。
- `SYSTEM_RUN_DENIED: approval required` → 実行リクエストに明示的な承認が必要です。
- `SYSTEM_RUN_DENIED: allowlist miss` → コマンドが許可リストモードによりブロックされています。

## 迅速な復旧ループ

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

それでも解決しない場合:

- デバイスのペアリングを再承認します。
- ノードアプリを再度開きます（フォアグラウンド）。
- OS の権限を再付与します。
- 実行承認ポリシーを再作成 / 調整します。

関連:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
