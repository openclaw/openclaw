---
name: camsnap
description: Capture frames or clips from RTSP/ONVIF cameras.
homepage: https://camsnap.ai
metadata:
  {
    "openclaw":
      {
        "emoji": "📸",
        "requires": { "bins": ["camsnap"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/camsnap",
              "bins": ["camsnap"],
              "label": "Install camsnap (brew)",
            },
          ],
      },
  }
---

# camsnap

使用 `camsnap` 从已配置的相机抓取快照、片段或运动事件。

设置

- 配置文件：`~/.config/camsnap/config.yaml`
- 添加相机：`camsnap add --name kitchen --host 192.168.0.10 --user user --pass pass`

常用命令

- 发现：`camsnap discover --info`
- 快照：`camsnap snap kitchen --out shot.jpg`
- 片段：`camsnap clip kitchen --dur 5s --out clip.mp4`
- 运动监控：`camsnap watch kitchen --threshold 0.2 --action '...'`
- 诊断：`camsnap doctor --probe`

注意事项

- 需要 `ffmpeg` 在 PATH 上。
- 在录制更长片段之前优先进行短测试捕获。
