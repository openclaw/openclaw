---
summary: "WebSocket リスナーのバインドを使用した Gateway シングルトンガード"
read_when:
  - Gateway プロセスを実行またはデバッグする場合
  - 単一インスタンスの強制を調査する場合
title: "Gateway ロック"
---

# Gateway ロック

最終更新日: 2025-12-11

## なぜ必要か

- 同一ホスト上の同一ベースポートにつき 1 つの Gateway インスタンスのみが実行されることを保証します。追加の Gateway は、分離されたプロファイルと一意のポートを使用する必要があります。
- クラッシュや SIGKILL 発生時でも、古いロックファイルを残さずに動作します。
- 制御ポートがすでに使用されている場合に、明確なエラーで即座に失敗します。

## 仕組み

- Gateway は起動直後に、排他的な TCP リスナーを使用して WebSocket リスナー（デフォルトは `ws://127.0.0.1:18789`）をバインドします。
- バインドが `EADDRINUSE` で失敗した場合、起動時に `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")` がスローされます。
- OS は、クラッシュや SIGKILL を含むあらゆるプロセス終了時に自動的にリスナーを解放します。そのため、個別のロックファイルやクリーンアップ手順は不要です。
- シャットダウン時には、Gateway が WebSocket サーバーとその下位の HTTP サーバーをクローズし、ポートを速やかに解放します。

## エラーの表面化

- 別のプロセスがポートを保持している場合、起動時に `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")` がスローされます。
- その他のバインド失敗は `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")` として表面化します。

## 運用上の注記

- ポートが「別の」プロセスによって占有されている場合でも、エラーは同じです。ポートを解放するか、`openclaw gateway --port <port>` を使用して別のポートを選択してください。
- macOS アプリは、Gateway を起動する前に独自の軽量な PID ガードを引き続き維持しますが、実行時のロックは WebSocket のバインドによって強制されます。
