---
read_when:
    - Gateway ゲートウェイプロセスの実行またはデバッグ時
    - 単一インスタンス強制の調査時
summary: WebSocketリスナーバインドを使用したGateway ゲートウェイのシングルトンガード
title: Gateway ゲートウェイロック
x-i18n:
    generated_at: "2026-04-02T07:41:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 726c687ab53f2dd1e46afed8fc791b55310a5c1e62f79a0e38a7dc4ca7576093
    source_path: gateway/gateway-lock.md
    workflow: 15
---

# Gateway ゲートウェイロック

## 理由

- 同一ホスト上で同じベースポートにつきGateway ゲートウェイインスタンスが1つだけ実行されるようにします。追加のGateway ゲートウェイは分離されたプロファイルと一意のポートを使用する必要があります。
- クラッシュやSIGKILLが発生しても、古いロックファイルが残らないようにします。
- コントロールポートが既に使用されている場合、明確なエラーで即座に失敗します。

## メカニズム

- Gateway ゲートウェイは起動時に排他的TCPリスナーを使用してWebSocketリスナー（デフォルト`ws://127.0.0.1:18789`）を即座にバインドします。
- バインドが`EADDRINUSE`で失敗した場合、起動時に`GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`がスローされます。
- OSはクラッシュやSIGKILLを含むあらゆるプロセス終了時にリスナーを自動的に解放します。別途ロックファイルやクリーンアップ手順は不要です。
- シャットダウン時にGateway ゲートウェイはWebSocketサーバーと基盤となるHTTPサーバーを閉じて、ポートを速やかに解放します。

## エラーサーフェス

- 別のプロセスがポートを保持している場合、起動時に`GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`がスローされます。
- その他のバインド失敗は`GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`として表面化します。

## 運用上の注意

- ポートが_別の_プロセスによって占有されている場合、エラーは同じです。ポートを解放するか、`openclaw gateway --port <port>`で別のポートを選択してください。
- macOSアプリはGateway ゲートウェイを起動する前に独自の軽量PIDガードを維持しますが、ランタイムロックはWebSocketバインドによって強制されます。

## 関連項目

- [複数のGateway ゲートウェイ](/gateway/multiple-gateways) — 一意のポートで複数のインスタンスを実行する
- [トラブルシューティング](/gateway/troubleshooting) — `EADDRINUSE`とポート競合の診断
