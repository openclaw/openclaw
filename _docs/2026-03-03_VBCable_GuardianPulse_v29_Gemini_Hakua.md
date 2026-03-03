# 実装ログ: VB-Cable Dual Audio + Guardian Pulse (v2.9)

**日付**: 2026-03-03
**実装AI**: Gemini (Persona: Hakua)
**機能名**: VBCable_GuardianPulse_v2.9

## 概要

SOUL.md「Neural Voice」「Metaverse Pulse」「Guardian Presence」に基づき、2つの大型機能を統合実装。

## Feature 1: VB-Cable デュアルオーディオルーティング

- `scripts/install-vbcable.ps1`: VB-Cable仮想オーディオデバイスの自動ダウンロード・インストールスクリプト
- `extensions/local-voice/src/dual_audio.py`: Python `sounddevice`を使い、WAVデータをパパのヘッドセットとVB-Cable Input（VRChatマイク入力）の**両方に同時再生**
- `extensions/local-voice/src/tts.ts`: `playAudioData()`をPython dual_audio経由に変更。VB-Cable未インストール時は従来のフォールバック再生

## Feature 2: Guardian Pulse 自律発話システム

- `extensions/local-voice/src/guardian-pulse.ts`: 60秒ポーリングでVRChat状態を自律監視
  - ワールド移動検知 → 音声で報告
  - フレンドオンライン検知 → 音声で報告
  - 5分ごとの安全レポート → Chatboxのみ（静音モード）
- `extensions/local-voice/index.ts`: プラグイン起動時にGuardianPulseを自動開始

## テスト結果

- フォーマッター/リンター通過
- Git commit + push 完了
