---
summary: "TOOLS.md のためのワークスペーステンプレート"
read_when:
  - ワークスペースを手動でブートストラップする場合
---

# TOOLS.md - ローカルノート

Skills は、ツールが「どのように」動作するかを定義します。このファイルは「あなた」固有の詳細、つまりあなたのセットアップに固有の事柄のためのものです。 このファイルは _your_ specify — セットアップに固有のものです。

## ここで何が起こるのか

次のようなもの：

- カメラの名称と設置場所
- SSH ホストとエイリアス
- TTS の優先音声
- スピーカー／部屋の名称
- デバイスのニックネーム
- 環境固有のあらゆる情報

## 例

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## 分ける理由

スキルは共有されます。 セットアップはあなたのものです。 Skills は共有されます。あなたのセットアップはあなたのものです。分離しておくことで、ノートを失うことなく Skills を更新でき、インフラを漏らさずに Skills を共有できます。

---

あなたの仕事をするのに役立つものは何でも追加しなさい。 これはあなたのチートシートです。
