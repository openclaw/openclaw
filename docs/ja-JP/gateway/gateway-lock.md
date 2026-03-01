---
summary: "WebSocketリスナーバインドを使用したGatewayシングルトンガード"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gatewayロック"
---

# Gatewayロック

最終更新：2025-12-11

## 理由

- 同じホスト上のベースポートごとに1つのGatewayインスタンスのみが実行されるようにします。追加のGatewayは分離されたプロファイルと一意のポートを使用する必要があります。
- クラッシュ/SIGKILLを生き延びて、古いロックファイルを残しません。
- コントロールポートが既に使用されている場合、明確なエラーで即座に失敗します。

## メカニズム

- Gatewayは起動時に排他的TCPリスナーを使用してWebSocketリスナー（デフォルト`ws://127.0.0.1:18789`）を即座にバインドします。
- バインドが`EADDRINUSE`で失敗した場合、起動は`GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`をスローします。
- OSはクラッシュやSIGKILLを含むすべてのプロセス終了時にリスナーを自動的に解放します。別のロックファイルやクリーンアップステップは必要ありません。
- シャットダウン時にGatewayはWebSocketサーバーと基盤のHTTPサーバーを閉じてポートを速やかに解放します。

## エラーサーフェス

- 別のプロセスがポートを保持している場合、起動は`GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`をスローします。
- その他のバインド失敗は`GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: ...")`として表面化します。

## 運用上の注意

- ポートが_別の_プロセスによって占有されている場合、エラーは同じです。ポートを解放するか、`openclaw gateway --port <port>`で別のポートを選択してください。
- macOSアプリはGateway起動前に独自の軽量PIDガードを引き続き維持します。ランタイムロックはWebSocketバインドによって強制されます。
