# Multimodal Messaging - 多媒体消息处理技能

_当用户在 QQ、微信、Telegram、飞书 发送图片、语音、文件时使用此技能。_

---

## 核心原则

用户通过任何 IM 渠道发来的多媒体（图片/语音/文件），AI 必须主动处理并理解，不能说"无法处理"或"不支持"。每条消息都是一个交互机会。

---

## 图片处理

### 接收
用户发来的图片自动下载到本地，路径在会话上下文的【附件】中。

### 理解
使用 `minimax-tokenplan__understand_image` 工具：

```
prompt: "详细描述这张图片的完整内容，包括所有文字、人物、物体、场景、数据图表等细节。"
image: "图片文件路径"
```

### QQ 发送图片
```xml
<qqimg>/path/to/image.jpg</qqimg>
```

### 微信发送图片
直接发送路径或用相同标签，系统自动处理。

### Telegram 发送图片
通过 message 工具的 `media` 参数发送。

### 飞书发送图片
使用 feishu_doc 的图片上传能力，或通过 image_generate 生成后发送 URL。

---

## 语音处理

### 接收
用户发来的语音消息自动下载，路径在会话上下文【附件】中。

### 转写
用 faster-whisper（系统已安装），通过 exec 调用：

```bash
python3 /root/.openclaw/workspace/multimodal-agent.py voice /path/to/voice.mp3
```

返回格式示例：
```
【语音转写】语言: zh
你好，我想咨询一下明天会议的时间...
```

### 基于语音内容回复
语音转写后，把转写文本和你的回复一起发送。

---

## 文件处理

### 支持格式
| 类型 | 处理方式 |
|------|---------|
| 图片 (jpg/png/gif/webp/bmp) | MiniMax 图片理解 |
| PDF | 文字层提取 + OCR + 内嵌图片理解 |
| Word (docx) | OpenXML 解析文本内容 |
| Excel (xlsx) | OpenXML 解析表格 |
| PPT (pptx) | OpenXML 解析幻灯片文本 |
| 文本 (txt/md/py/js/csv/json/yaml) | 直接读取内容 |
| 音频 (mp3/wav/m4a/ogg) | 语音转写 |
| 压缩包 (zip/rar/7z) | 列出内容 |

### 处理命令
```bash
python3 /root/.openclaw/workspace/multimodal-agent.py file /path/to/file
```

### 返回文件（QQ）
```xml
<qqfile>/path/to/file</qqfile>
```

### 返回文件（微信）
上传到临时存储，发送下载链接或直接发送文件。

---

## 文件修改（自然语言）

当用户说"帮我修改"、"改成"、"添加内容"等，使用 modify 命令：

```bash
python3 /root/.openclaw/workspace/multimodal-agent.py modify /path/to/file "你的修改要求"
```

修改要求示例：
- `"把标题从'会议纪要'改成'项目进度报告'"`
- `"在最后添加一行：负责人：张三"`
- `"删除第二段"`
- `"把所有的'2024'替换成'2025'"`

### 返回修改后的文件
modify 命令会在原文件同目录下生成 `.modified.txt` 文件。

对于代码/Python 文件，直接读取并用 exec + write 修改：
1. 用 exec 读原文件：`cat /path/to/file`
2. 用 AI 理解修改要求
3. 用 write 工具写修改后的内容到原路径

对于 Word/Excel 等复杂格式，输出 `.modified.txt` 文本版本，并告知用户原格式保持不变。

---

## 流程总结

```
用户发送图片 → minimax-tokenplan__understand_image → AI 理解后回复
用户发送语音 → multimodal-agent.py voice → 转写 → AI 理解后回复
用户发送文件 → multimodal-agent.py file → 提取内容 → AI 理解后回复
用户要求修改文件 → multimodal-agent.py modify → AI 生成修改 → 写回文件 → 通知用户
```

---

## 快捷命令汇总

```bash
# 图片理解（可选带 prompt）
python3 /root/.openclaw/workspace/multimodal-agent.py image /path/to/img.jpg "额外提示"

# 语音转写
python3 /root/.openclaw/workspace/multimodal-agent.py voice /path/to/audio.mp3

# 文件内容提取
python3 /root/.openclaw/workspace/multimodal-agent.py file /path/to/file.pdf

# 自然语言文件修改
python3 /root/.openclaw/workspace/multimodal-agent.py modify /path/to/file.txt "修改指令"
```

---

## 限制与注意事项

1. **文件大小**：单文件处理限制 20MB，超过建议告知用户压缩
2. **语音时长**：语音转写对超长音频（>10分钟）可能截断
3. **Office 修改**：Word/Excel/PPT 修改仅支持文本内容，格式/样式保留有限
4. **安全**：不执行用户上传的可执行文件（.exe/.sh/.bat/.ps1 等）
5. **编码**：优先使用 UTF-8，失败时尝试 GBK/Big5
