---
name: zai-vision
description: AI Agent's "eyes" for processing visual information. Specialized for frontend development and bug debugging. Convert UI to code, OCR optimization, error diagnosis, diagram understanding, and data visualization analysis.
metadata:
  openclaw:
    emoji: 👁️
    priority: high
    triggers:
      - "分析图片"
      - "看图"
      - "这个截图"
      - "UI 设计"
      - "错误截图"
      - "架构图"
      - "流程图"
      - "视频分析"
      - "OCR"
      - "识别文字"
      - "前端还原"
      - "UI 转代码"
---

# Vision Assistant - AI Agent 的"眼睛"

**弥补传统 LLM 只能处理文本的短板** - 将视觉感知与可执行动作无缝链接

## 核心优势

- ✅ **前端还原** - UI 截图直接生成可运行代码
- ✅ **自动化错误排查** - 分析报错截图，给出具体修复建议
- ✅ **优化的 OCR** - 专门针对代码、终端输出、技术文档
- ✅ **图表理解** - 从数据可视化中提取趋势和洞察

## 核心应用场景

1. **前端开发** - UI 设计稿 → 可运行代码
2. **Bug 调试** - 错误截图 → 修复方案
3. **代码审查** - 截图 OCR → 提取代码
4. **架构理解** - 技术图表 → 系统分析
5. **数据分析** - 图表仪表盘 → 趋势洞察

## Important Rules

### ⚠️ File Path Requirement

- **MUST use local file path**: `/path/to/image.png`
- **NEVER use URLs**: Will cause 400 error
- If user provides URL, download to `/tmp/` first

### File Format Support

- **Images**: JPG, PNG, WebP
- **Videos**: MP4, MOV, M4V (max 8MB)

## Automatic Tool Selection

### 1. UI to Code (前端还原神器)

**工具**: `zai-vision.ui_to_artifact`
**能力**: 直接将 UI 截图转换为可运行的代码、提示词或技术规格

**输出类型**:

- `code`: 生成可运行的前端代码
- `prompt`: 生成 AI 提示词（用于重新创建 UI）
- `spec`: 生成技术规格说明
- `description`: 自然语言描述

**示例**:

```
User: "把这个设计稿转成 React 代码 /tmp/design.png"
→ Call: mcporter call zai-vision.ui_to_artifact
         image_source="/tmp/design.png"
         output_type="code"
         prompt="生成 React 组件"
→ Result: 可直接运行的 React 代码
```

### 2. Optimized OCR (代码/终端/文档专用)

**工具**: `zai-vision.extract_text_from_screenshot`
**能力**: 专门优化针对以下场景的 OCR 识别

- 💻 代码截图
- 🖥️ 终端输出
- 📄 技术文档

**示例**:

```
User: "提取这个终端输出的文字 /tmp/terminal.png"
→ Call: mcporter call zai-vision.extract_text_from_screenshot
         image_source="/tmp/terminal.png"
         prompt="提取终端输出内容"
         programming_language="python"  # 可选
→ Result: 格式化的代码/文本
```

### 3. Error Diagnosis (开发者利器)

**工具**: `zai-vision.diagnose_error_screenshot`
**能力**: 分析报错截图并给出**具体的修复建议**

**示例**:

```
User: "看看这个错误怎么解决 /tmp/error.png"
→ Call: mcporter call zai-vision.diagnose_error_screenshot
         image_source="/tmp/error.png"
         prompt="分析错误原因并给出修复方案"
         context="运行 npm install 时出现"
→ Result: 错误原因 + 具体修复步骤
```

### 4. Technical Diagram Understanding (架构图理解)

**工具**: `zai-vision.understand_technical_diagram`
**能力**: 理解复杂的技术图表

- 🏗️ 系统架构图
- 🔄 流程图
- 📐 UML 图
- 🗃️ ER 图

**示例**:

```
User: "解释这个系统架构 /tmp/architecture.png"
→ Call: mcporter call zai-vision.understand_technical_diagram
         image_source="/tmp/architecture.png"
         prompt="详细解释这个架构的组成部分和数据流"
         diagram_type="architecture"
→ Result: 架构解析 + 组件说明 + 数据流分析
```

### 5. Data Visualization Analysis (图表洞察)

**工具**: `zai-vision.analyze_data_visualization`
**能力**: 从图表和仪表盘中提取数据趋势和洞察

**分析重点**:

- 📈 趋势识别
- ⚠️ 异常检测
- 🔍 对比分析
- 📊 性能指标

**示例**:

```
User: "分析这个仪表盘 /tmp/dashboard.png"
→ Call: mcporter call zai-vision.analyze_data_visualization
         image_source="/tmp/dashboard.png"
         prompt="提取关键指标和趋势"
         analysis_focus="performance metrics"
→ Result: 关键指标 + 趋势分析 + 异常提醒
```

## Workflow

1. **Detect file path** in user message
2. **Download if URL** (save to `/tmp/`)
3. **Determine tool** based on user intent
4. **Call via mcporter**
5. **Present results** in Chinese

## Error Handling

### If user provides URL:

1. Download to `/tmp/`: `curl -o /tmp/image.png "URL"`
2. Then analyze local file

### If file not found:

1. Ask user to verify path
2. Suggest checking file exists: `ls -la /path/to/file`

### If 400 error:

1. Confirm using local path (not URL)
2. Check file format (JPG/PNG)
3. For video: check size ≤ 8MB

## Integration Tips

- Always expand `~` to full path
- Timeout: 60 seconds default
- Present results in user's language (Chinese if asked in Chinese)
