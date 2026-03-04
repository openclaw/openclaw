---
name: qwen-image
description: Generate images using Alibaba Cloud Bailian Qwen-Image and Z-Image models (通义千图文生图 + 人像照片模型)
homepage: https://help.aliyun.com/zh/model-studio/qwen-image-api
metadata:
  openclaw:
    emoji: 🎨
  requires:
    env:
      - DASHSCOPE_API_KEY
---

# Qwen-Image / Z-Image Skill

基于阿里云百炼的文图生成技能，**智能识别场景**自动选择最佳模型：

- 🧍 **人像/照片** → **z-image-turbo**（专精高质量人像，支持胶片质感）
- 🖼️ **通用文图** → **qwen-image-max**（擅长复杂文字渲染、艺术风格）

## Features

- **🤖 智能模型选择**：自动检测人像场景，无需手动选择模型
- **🎨 双模型支持**：Qwen-Image（通用） + Z-Image（人像）
- **✍️ 中文文字渲染**：在图像中完美呈现复杂中文字符
- **📐 多尺寸支持**：16:9、4:3、1:1、3:4、9:16 等多种比例
- **🔧 可手动指定**：支持强制使用特定模型

## Setup

1. 从 [阿里云百炼控制台](https://bailian.console.aliyun.com/) 获取 API Key
2. 配置方式选择其一：
   - **环境变量**：`export DASHSCOPE_API_KEY="sk-xxx"`
   - **TOOLS.md**：在 TOOLS.md 中添加 `DASHSCOPE_API_KEY: sk-xxx`

> **地域注意**：北京和新加坡地域 API Key 不互通

## Available Models

| 模型                | 描述                               | 最佳场景                           |
| ------------------- | ---------------------------------- | ---------------------------------- |
| **qwen-image-max**  | 最佳质量，减少AI痕迹，文字渲染优秀 | 漫画、插画、图文设计、风景、静物   |
| **qwen-image-plus** | 质量与速度平衡                     | 通用场景                           |
| **qwen-image**      | 基础模型                           | 快速生成                           |
| **z-image-turbo**   | 人像专精，胶片质感，真实感强       | 人像照片、人像写真、film grain效果 |

## Supported Sizes

| 尺寸       | 比例 | 说明                 |
| ---------- | ---- | -------------------- |
| 1664\*928  | 16:9 | 横向宽屏（通用默认） |
| 1472\*1104 | 4:3  | 标准比例             |
| 1328\*1328 | 1:1  | 方形                 |
| 1104\*1472 | 3:4  | 竖向                 |
| 928\*1664  | 9:16 | 手机竖屏             |
| 1120\*1440 | 4:5  | **人像推荐**         |

## Usage

### 🎯 快速入门（推荐）

直接写提示词，**自动识别场景**并选择最佳模型：

```bash
# 人像类 → 自动使用 z-image-turbo
python scripts/generate.py "短发少女，清新自然风格，微笑"

# 通用类 → 自动使用 qwen-image-max
python scripts/generate.py "七龙珠孙悟空对战比克大魔王，漫画风格"

# 含film grain关键词 → 自动使用 z-image
python scripts/generate.py "胶片感，Kodak Portra 400风格的人像"
```

### 🔧 高级选项

```bash
python scripts/generate.py "prompt" \
    --model z \              # 强制指定模型 (z/qwen/auto)
    --size 1328*1328 \       # 图片尺寸
    --prompt-extend \        # 开启提示词扩展
    --no-watermark \         # 禁用水印
    --output my-image.png    # 输出路径
```

## Auto-Detection Keywords

以下关键词会触发自动选择 **z-image-turbo**：

**人物类**：人、女、男、少女、帅哥、美女、肖像、人物、face、facial

**照片/胶片类**：photo、photograph、film grain、analog、Kodak、胶片、portra、cinematic、photorealistic、真实、写真人像

## 使用示例

### 人像照片（z-image）

```bash
python scripts/generate.py "东亚年轻女性，户外雪地场景，film grain效果，胶片质感"
```

### 漫画风格（qwen-image）

```bash
python scripts/generate.py "七龙珠孙悟空对战比克大魔王，漫画风格，能量波爆炸，天空背景"
```

### 带中文文字的漫画

```bash
python scripts/generate.py "一副对联，上联：智启千问，下联：机道为善，横批：人机共生"
```

## Tips

- **人像首选 z-image**：对面部细节、皮肤质感、胶片感优化更好
- **文字渲染选 qwen**：复杂中文、图文混排场景更精准
- **自动模式省心**：无需纠结选哪个模型
- **提示词长度**：正向 ≤800字符，负向 ≤500字符
- **扩展提示词**：`--prompt-extend` 可以让AI自动优化你的描述

---

_Qwen-Image Skill - 国产文生图利器 🇨🇳_
