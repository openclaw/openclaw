---
read_when:
    - WSL2内でOpenClaw Gateway ゲートウェイを実行し、ChromeがWindows上にある場合
    - WSL2とWindowsにまたがるブラウザ/コントロールUIエラーが重複して表示される場合
    - 分割ホスト構成でホストローカルChrome MCPと生のリモートCDPのどちらを選ぶか決める場合
summary: WSL2 Gateway ゲートウェイ + Windows ChromeリモートCDPをレイヤーごとにトラブルシューティングする
title: WSL2 + Windows + リモートChrome CDPのトラブルシューティング
x-i18n:
    generated_at: "2026-04-02T08:59:54Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 76a6db5ee93dce528538f460a7e3b8def3ee29b2293aff69c0d224a266dc2e0f
    source_path: tools/browser-wsl2-windows-remote-cdp-troubleshooting.md
    workflow: 15
---

# WSL2 + Windows + リモートChrome CDPのトラブルシューティング

このガイドでは、以下のような一般的な分割ホスト構成について説明します:

- OpenClaw Gateway ゲートウェイがWSL2内で実行されている
- ChromeがWindows上で実行されている
- ブラウザ制御がWSL2/Windows境界を越える必要がある

また、[issue #39369](https://github.com/openclaw/openclaw/issues/39369)で報告されたレイヤード障害パターンについても説明します。複数の独立した問題が同時に発生し、誤ったレイヤーが最初に壊れているように見えることがあります。

## まず適切なブラウザモードを選択する

有効なパターンは2つあります:

### オプション1: WSL2からWindowsへの生のリモートCDP

WSL2からWindows Chrome CDPエンドポイントを指すリモートブラウザプロファイルを使用します。

以下の場合に選択してください:

- Gateway ゲートウェイがWSL2内にとどまる
- ChromeがWindows上で実行されている
- ブラウザ制御がWSL2/Windows境界を越える必要がある

### オプション2: ホストローカルChrome MCP

Gateway ゲートウェイ自体がChromeと同じホスト上で実行されている場合にのみ、`existing-session` / `user`を使用してください。

以下の場合に選択してください:

- OpenClawとChromeが同じマシン上にある
- ローカルのサインイン済みブラウザ状態を使用したい
- クロスホストブラウザトランスポートが不要

WSL2 Gateway ゲートウェイ + Windows Chromeの場合は、生のリモートCDPを推奨します。Chrome MCPはホストローカルであり、WSL2からWindowsへのブリッジではありません。

## 動作するアーキテクチャ

参考構成:

- WSL2がGateway ゲートウェイを`127.0.0.1:18789`で実行
- WindowsがコントロールUIを通常のブラウザで`http://127.0.0.1:18789/`に開く
- Windows Chromeがポート`9222`でCDPエンドポイントを公開
- WSL2がそのWindowsのCDPエンドポイントに到達可能
- OpenClawがWSL2から到達可能なアドレスを指すブラウザプロファイルを設定

## この構成が紛らわしい理由

複数の障害が重なることがあります:

- WSL2がWindowsのCDPエンドポイントに到達できない
- コントロールUIが非セキュアオリジンから開かれている
- `gateway.controlUi.allowedOrigins`がページのオリジンと一致しない
- トークンまたはペアリングが欠落している
- ブラウザプロファイルが間違ったアドレスを指している

そのため、1つのレイヤーを修正しても、別のエラーが引き続き表示されることがあります。

## コントロールUIに関する重要なルール

UIをWindowsから開く場合、意図的なHTTPSセットアップがない限り、Windowsのlocalhostを使用してください。

使用するアドレス:

`http://127.0.0.1:18789/`

コントロールUIにデフォルトでLAN IPを使用しないでください。LANまたはtailnetアドレスでのプレーンHTTPは、CDP自体とは無関係な非セキュアオリジン/デバイス認証の動作を引き起こす可能性があります。[コントロールUI](/web/control-ui)を参照してください。

## レイヤーごとに検証する

上から下へ順に進めてください。先にスキップしないでください。

### レイヤー1: WindowsでChromeがCDPを提供していることを確認

リモートデバッグを有効にしてWindows上でChromeを起動します:

```powershell
chrome.exe --remote-debugging-port=9222
```

Windowsから、まずChrome自体を確認します:

```powershell
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

これがWindows上で失敗する場合、まだOpenClawの問題ではありません。

### レイヤー2: WSL2からそのWindowsエンドポイントに到達できることを確認

WSL2から、`cdpUrl`で使用する予定の正確なアドレスをテストします:

```bash
curl http://WINDOWS_HOST_OR_IP:9222/json/version
curl http://WINDOWS_HOST_OR_IP:9222/json/list
```

正常な結果:

- `/json/version`がBrowser / Protocol-Versionメタデータを含むJSONを返す
- `/json/list`がJSONを返す（ページが開いていない場合、空の配列でもOK）

これが失敗する場合:

- WindowsがまだWSL2にポートを公開していない
- WSL2側のアドレスが間違っている
- ファイアウォール / ポートフォワーディング / ローカルプロキシがまだ設定されていない

OpenClawの設定を変更する前にこれを修正してください。

### レイヤー3: 正しいブラウザプロファイルを設定する

生のリモートCDPの場合、WSL2から到達可能なアドレスをOpenClawに設定します:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "remote",
    profiles: {
      remote: {
        cdpUrl: "http://WINDOWS_HOST_OR_IP:9222",
        attachOnly: true,
        color: "#00AA00",
      },
    },
  },
}
```

注意事項:

- Windows上でのみ機能するアドレスではなく、WSL2から到達可能なアドレスを使用してください
- 外部管理されているブラウザには`attachOnly: true`を維持してください
- OpenClawの成功を期待する前に、同じURLを`curl`でテストしてください

### レイヤー4: コントロールUIレイヤーを別途検証する

WindowsからUIを開きます:

`http://127.0.0.1:18789/`

次に確認します:

- ページのオリジンが`gateway.controlUi.allowedOrigins`の期待値と一致しているか
- トークン認証またはペアリングが正しく設定されているか
- コントロールUIの認証問題をブラウザの問題として誤ってデバッグしていないか

参考ページ:

- [コントロールUI](/web/control-ui)

### レイヤー5: エンドツーエンドのブラウザ制御を検証する

WSL2から:

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
```

正常な結果:

- Windows Chromeでタブが開く
- `openclaw browser tabs`がターゲットを返す
- 以降のアクション（`snapshot`、`screenshot`、`navigate`）が同じプロファイルから動作する

## よくある誤解を招くエラー

各メッセージをレイヤー固有の手がかりとして扱ってください:

- `control-ui-insecure-auth`
  - CDPトランスポートの問題ではなく、UIオリジン/セキュアコンテキストの問題
- `token_missing`
  - 認証設定の問題
- `pairing required`
  - デバイス承認の問題
- `Remote CDP for profile "remote" is not reachable`
  - WSL2が設定された`cdpUrl`に到達できない
- `gateway timeout after 1500ms`
  - CDPの到達性の問題、または低速/到達不能なリモートエンドポイントが原因であることが多い
- `No Chrome tabs found for profile="user"`
  - ホストローカルタブが利用できない場所でローカルChrome MCPプロファイルが選択されている

## クイックトリアージチェックリスト

1. Windows: `curl http://127.0.0.1:9222/json/version`は動作するか?
2. WSL2: `curl http://WINDOWS_HOST_OR_IP:9222/json/version`は動作するか?
3. OpenClaw設定: `browser.profiles.<name>.cdpUrl`がそのWSL2から到達可能なアドレスを使用しているか?
4. コントロールUI: LAN IPではなく`http://127.0.0.1:18789/`を開いているか?
5. 生のリモートCDPの代わりに`existing-session`をWSL2とWindowsの間で使おうとしていないか?

## 実用的なポイント

このセットアップは通常問題なく動作します。難しいのは、ブラウザトランスポート、コントロールUIのオリジンセキュリティ、トークン/ペアリングがそれぞれ独立して失敗する可能性がありながら、ユーザー側からは似たように見えることです。

判断に迷った場合:

- まずWindows ChromeエンドポイントをWindowsローカルで検証する
- 次にWSL2から同じエンドポイントを検証する
- その後でOpenClaw設定やコントロールUI認証をデバッグする
