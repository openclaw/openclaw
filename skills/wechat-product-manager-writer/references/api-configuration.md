# API 配置指南

生成封面图需要配置图片生成 API。

## 支持的 API

| API           | 推荐度 | 中文效果 | 备注         |
| ------------- | ------ | -------- | ------------ |
| Gemini Imagen | 推荐   | 较好     | 免费额度充足 |
| DALL-E 3      | 备选   | 一般     | 需付费       |

---

## Gemini API 配置（推荐）

### 1. 获取密钥

访问 [Google AI Studio](https://aistudio.google.com/app/apikey) 获取 API 密钥。

### 2. 设置环境变量

```bash
# Linux/Mac
export GEMINI_API_KEY="your-api-key"

# 或添加到 ~/.bashrc 或 ~/.zshrc
echo 'export GEMINI_API_KEY="your-api-key"' >> ~/.bashrc
source ~/.bashrc
```

### 3. 测试

```bash
cd /root/.claude/skills/wechat-product-manager-writer

python scripts/generate_image.py \
  --prompt "A test image with Chinese text '测试'" \
  --api gemini \
  --output test.png
```

---

## DALL-E API 配置（备选）

### 1. 获取密钥

访问 [OpenAI Platform](https://platform.openai.com/api-keys) 获取 API 密钥。

### 2. 设置环境变量

```bash
export OPENAI_API_KEY="your-api-key"
```

### 3. 使用

```bash
python scripts/generate_image.py \
  --prompt "你的提示词" \
  --api dalle \
  --quality hd \
  --size 1792x1024 \
  --output cover.png
```

---

## 常见问题

**API 密钥无效**：检查是否正确设置环境变量，重启终端后重试。

**生成失败**：检查网络连接，部分地区可能需要代理。

**中文显示问题**：Gemini 对中文支持更好，建议优先使用。
