---
read_when:
    - エージェントがツール呼び出しを繰り返してスタックしているとユーザーから報告があった場合
    - 繰り返し呼び出し保護を調整する必要がある場合
    - エージェントのツール/ランタイムポリシーを編集している場合
summary: 繰り返しツール呼び出しループを検出するガードレールの有効化と調整方法
title: ツールループ検出
x-i18n:
    generated_at: "2026-04-02T07:56:06Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: dc3c92579b24cfbedd02a286b735d99a259b720f6d9719a9b93902c9fc66137d
    source_path: tools/loop-detection.md
    workflow: 15
---

# ツールループ検出

OpenClaw はエージェントが繰り返しのツール呼び出しパターンにスタックするのを防ぐことができます。
このガードは**デフォルトでは無効**です。

厳密な設定では正当な繰り返し呼び出しもブロックされる可能性があるため、必要な場合にのみ有効にしてください。

## この機能が存在する理由

- 進捗のない繰り返しシーケンスを検出する。
- 高頻度の結果なしループ（同じツール、同じ入力、繰り返しエラー）を検出する。
- 既知のポーリングツールにおける特定の繰り返し呼び出しパターンを検出する。

## 設定ブロック

グローバルデフォルト：

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

エージェントごとのオーバーライド（任意）：

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

### フィールドの動作

- `enabled`：マスタースイッチ。`false` の場合、ループ検出は実行されない。
- `historySize`：分析用に保持する最近のツール呼び出し数。
- `warningThreshold`：パターンを警告のみとして分類するまでのしきい値。
- `criticalThreshold`：繰り返しループパターンをブロックするためのしきい値。
- `globalCircuitBreakerThreshold`：グローバルな進捗なしブレーカーのしきい値。
- `detectors.genericRepeat`：同一ツール＋同一パラメータの繰り返しパターンを検出する。
- `detectors.knownPollNoProgress`：状態変化のない既知のポーリングライクなパターンを検出する。
- `detectors.pingPong`：交互に発生するピンポンパターンを検出する。

## 推奨セットアップ

- まず `enabled: true` で開始し、デフォルト値のまま使用する。
- しきい値の順序を `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold` に保つ。
- 誤検知が発生した場合：
  - `warningThreshold` や `criticalThreshold` を引き上げる
  - （任意で）`globalCircuitBreakerThreshold` を引き上げる
  - 問題を引き起こしているディテクターのみを無効にする
  - `historySize` を減らして履歴コンテキストを緩和する

## ログと期待される動作

ループが検出されると、OpenClaw はループイベントを報告し、重大度に応じて次のツールサイクルをブロックまたは抑制します。
これにより、通常のツールアクセスを維持しながら、トークンの暴走消費やロックアップからユーザーを保護します。

- まず警告と一時的な抑制を優先する。
- 繰り返しのエビデンスが蓄積された場合にのみエスカレーションする。

## 注意事項

- `tools.loopDetection` はエージェントレベルのオーバーライドとマージされる。
- エージェントごとの設定はグローバル値を完全にオーバーライドまたは拡張する。
- 設定が存在しない場合、ガードレールはオフのまま。
