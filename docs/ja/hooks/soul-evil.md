---
summary: "SOUL Evil フック（SOUL.md を SOUL_EVIL.md に切り替え）"
read_when:
  - SOUL Evil フックを有効化または調整したい場合
  - パージウィンドウやランダム確率のペルソナ切り替えを行いたい場合
title: "SOUL Evil フック"
---

# SOUL Evil フック

SOUL Evil フックは、パージウィンドウ中またはランダムな確率によって、**注入された** `SOUL.md` コンテンツを `SOUL_EVIL.md` に入れ替えます。ディスク上のファイルは**変更しません**。 ディスク上のファイルを **変更**しません\*\* 。

## 仕組み

`agent:bootstrap` が実行される際、このフックはシステムプロンプトが組み立てられる前に、メモリ内の `SOUL.md` コンテンツを置き換えることができます。`SOUL_EVIL.md` が存在しない、または空の場合、OpenClaw は警告をログに記録し、通常の `SOUL.md` を保持します。 `SOUL_EVIL.md` が見つからないか空の場合、
OpenClawは警告をログに記録し、通常の `SOUL.md` を保持します。

サブエージェントの実行には、ブートストラップファイルに `SOUL.md` が含まれないため、このフックはサブエージェントには影響しません。

## 有効化

```bash
openclaw hooks enable soul-evil
```

次に、設定を行います。

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

エージェントのワークスペースルート（`SOUL.md` の隣）に `SOUL_EVIL.md` を作成します。

## オプション

- `file`（string）: 代替の SOUL ファイル名（デフォルト: `SOUL_EVIL.md`）
- `chance`（number 0–1）: 実行ごとに `SOUL_EVIL.md` を使用するランダム確率
- `purge.at`（HH:mm）: 日次パージ開始時刻（24 時間表記）
- `purge.duration`（duration）: ウィンドウ長（例: `30s`、`10m`、`1h`）

**優先順位:** パージウィンドウは確率設定より優先されます。

**タイムゾーン:** 設定されている場合は `agents.defaults.userTimezone` を使用し、未設定の場合はホストのタイムゾーンを使用します。

## 注記

- ディスク上のファイルは書き込まれたり変更されたりしません。
- `SOUL.md` がブートストラップリストに含まれていない場合、このフックは何もしません。

## See Also

- [Hooks](/automation/hooks)
