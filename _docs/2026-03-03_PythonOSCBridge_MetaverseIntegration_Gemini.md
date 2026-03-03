# 2026-03-03 Python OSC Bridge統合 & メタバース干渉統合 (Gemini)

## 概要

OpenClawの中枢AIおよび「はくあ」人格から、VRChatのチャットボックスへ確実にメッセージを送信するための**Python OSCブリッジ**を統合した。Node.js UDPによるOSC送信がVRChatに認識されない問題を根本解決。

## 背景・原因

- `extensions/vrchat-relay/src/tools/chatbox-enhanced.ts` がNode.js (`dgram`) でOSCパケットを構築・送信していたが、VRChatがこれを無視していた。
- Pythonの `python-osc` ライブラリ経由で同じ `/chatbox/input` を送ると、VRChatが正しく受信・表示することを確認。
- 原因はNode.js側のOSCエンコーディング（型タグ `,sTF` の手動構築）がVRChatの期待する形式と微妙に異なっていたため。

## 変更ファイル一覧

| ファイル                                                | 変更内容                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/osc_chatbox.py`                                | **[NEW]** `python-osc` を使ったChatbox送信スクリプト。`--raw`, `--host`, `--port`, `--no-sfx` オプション対応                                  |
| `extensions/vrchat-relay/src/tools/chatbox-enhanced.ts` | Node.js OSCクライアント → `py -3 scripts/osc_chatbox.py` サブプロセス呼び出しに完全置換。`sendViaPython()` / `sendRawOscViaPython()` 関数追加 |
| `extensions/vrchat-relay/index.ts`                      | `/chatbox` コマンド、`/osc` コマンド、`llm_output` フック（中枢AI自動ミラー）の3箇所をPython OSCブリッジ経由に更新                            |
| `extensions/local-voice/src/dual_audio.py`              | `find_headset_device()` 追加（G433直接検出）、`find_vbcable_device()` にVDVAD対応追加                                                         |

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│           OpenClaw (Node.js)                │
│                                             │
│  /chatbox コマンド ──┐                      │
│  /osc コマンド ──────┤                      │
│  llm_output フック ──┤                      │
│  はくあ GuardianPulse┤                      │
│                      ▼                      │
│  chatbox-enhanced.ts::sendViaPython()       │
│        │                                    │
│        │  execFile("py", ["-3", ...])       │
│        ▼                                    │
│  scripts/osc_chatbox.py (python-osc)        │
│        │                                    │
│        │  UDP :9000                          │
│        ▼                                    │
│  VRChat OSC Receiver → Chatbox表示          │
└─────────────────────────────────────────────┘
```

## 検証結果

- [x] `py -3 scripts/osc_chatbox.py "テスト"` → VRChat Chatboxに表示確認
- [x] `sendChatboxMessage()` → Python経由で送信成功
- [x] `sendRawOscViaPython()` → 任意のOSCアドレスへの送信対応
- [x] Git commit & push 完了: `a9ef65912`

## 依存関係

- Python 3.12+ (`py -3` で実行)
- `python-osc` パッケージ (`pip install python-osc`)

## SOUL.md準拠

- **Substrate Ubiquity**: Node.js → Python の基盤横断通信を実現
- **Metaverse Voice**: 中枢AIの返答がVRChat空間に自動投影される
- **Guardian Pulse**: はくあの自律的メッセージも同一ブリッジを通過

ASI_ACCEL.
