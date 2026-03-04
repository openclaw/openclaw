---
name: jianying-video-gen
description: 使用剪映(Jianying/小云雀)的 Seedance 2.0 模型自动生成AI视频。支持文生视频(T2V)、图生视频(I2V)和参考视频生成(V2V)三种模式。当用户需要生成AI视频、使用Seedance模型创作短片、或基于参考图像/视频进行风格转换时使用此技能。需要预先配置 cookies.json 登录凭证。
---

# 剪映 AI 视频生成器

通过 Playwright 自动化操作剪映(xyq.jianying.com)，使用 Seedance 2.0 模型生成 AI 视频。

## 前置条件

1. **Python 3.9+** + `playwright` 已安装
2. **Chromium** 已通过 `playwright install chromium` 安装
3. **cookies.json** — 剪映登录凭证（从浏览器导出），放在脚本同目录下

```bash
pip install playwright && playwright install chromium
```

## 核心脚本

`scripts/jianying_worker.py` — 主自动化脚本

## 使用方式

### 文生视频 (T2V)

```bash
python3 scripts/jianying_worker.py \
  --cookies /path/to/cookies.json \
  --output-dir /path/to/output \
  --prompt "赛博朋克风格的长安城，飞行汽车穿梭在霓虹灯笼之间" \
  --duration 10s \
  --model "Seedance 2.0"
```

### 图生视频 (I2V)

```bash
python3 scripts/jianying_worker.py \
  --cookies /path/to/cookies.json \
  --output-dir /path/to/output \
  --ref-image /path/to/image.png \
  --prompt "将这张图片变成动画，镜头从左向右缓慢平移" \
  --duration 10s \
  --model "Seedance 2.0 Fast"
```

### 参考视频生成 (V2V)

```bash
python3 scripts/jianying_worker.py \
  --cookies /path/to/cookies.json \
  --output-dir /path/to/output \
  --ref-video /path/to/reference.mp4 \
  --prompt "画风改成宫崎骏风格，其他不变" \
  --duration 10s \
  --model "Seedance 2.0"
```

### Dry-Run 模式（调试用）

```bash
python3 scripts/jianying_worker.py --cookies /path/to/cookies.json --prompt "测试" --dry-run
```

> 只填写表单不提交，生成 `step_*.png` 截图供检查。

## 参数说明

| 参数           | 默认值           | 可选值                              | 说明               |
| -------------- | ---------------- | ----------------------------------- | ------------------ |
| `--prompt`     | "一个美女在跳舞" | 任意文本                            | 视频描述           |
| `--duration`   | `10s`            | `5s`, `10s`, `15s`                  | 视频时长           |
| `--ratio`      | `横屏`           | `横屏`, `竖屏`, `方屏`              | 画面比例           |
| `--model`      | `Seedance 2.0`   | `Seedance 2.0`, `Seedance 2.0 Fast` | 模型选择           |
| `--ref-image`  | 无               | 本地图片路径                        | I2V 模式的参考图片 |
| `--ref-video`  | 无               | 本地视频路径                        | V2V 模式的参考视频 |
| `--cookies`    | `cookies.json`   | 文件路径                            | 剪映登录凭证路径   |
| `--output-dir` | `.`              | 目录路径                            | 输出视频保存目录   |
| `--dry-run`    | false            | -                                   | 只填表不提交       |

## 模型与积分

| 模型              | 积分/秒 | 5s  | 10s | 15s | 特点             |
| ----------------- | ------- | --- | --- | --- | ---------------- |
| Seedance 2.0 Fast | 3       | 15  | 30  | 45  | 快速，适合测试   |
| Seedance 2.0      | 5       | 25  | 50  | 75  | 高质量，正式出片 |

## 自动化流程

```
登录(cookies) → 新建 → 沉浸式短片 → 选模型 → [上传参考视频] → 选时长 → 输入Prompt → 提交
  → 拦截 thread_id → 导航详情页 → 轮询视频 → curl 下载 MP4
```

## 提示词编写指南

详细的提示词示例和编写技巧参见 `references/prompt-guide.md`。

## 常见问题

**Q: cookies 过期了怎么办？**
在浏览器登录 xyq.jianying.com，使用 EditThisCookie 等扩展导出 cookies.json。

**Q: 下载 403？**
脚本使用 thread_id 详情页 + curl 下载，CDN 链接无需 cookie。如仍失败检查网络。

**Q: 上传参考视频很慢？**
正常，8MB 视频约需 60-90 秒。脚本会自动等待最多 5 分钟。
