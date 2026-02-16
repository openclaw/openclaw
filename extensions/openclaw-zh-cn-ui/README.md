# OpenClaw 中文界面翻译[English](./README.en.md) | 简体中文

## 🎯 项目目标

为 OpenClaw 提供完整的中文界面支持，包括：

- Web 控制台（Control UI）
- CLI 命令行输出
- 错误消息和提示
- 配置界面

## 📊 当前状态

### 翻译进度
- ✅ **70个核心界面字符串已翻译**（按钮、状态、术语）
- ⏳ **371个界面文本待翻译**
- ❌ **2940个代码片段**（无需翻译）

### 已翻译的核心术语
Gateway → 网关
Agent → 智能体
Session → 会话
Channel → 通道
Plugin → 插件
Node → 节点
Dashboard → 仪表板
Configuration → 配置
Settings → 设置
Save → 保存
Cancel → 取消
Close → 关闭
Open → 打开
Delete → 删除
Edit → 编辑
Add → 添加
Remove → 移除
Refresh → 刷新
...（共70个）


## 🚀 快速开始

### 使用已翻译的字符串
```javascript
// 在你的项目中导入
const translations = require('./translations/zh-CN.json');
console.log(translations['Save']); // 输出：保存
继续翻译工作
# 1. 提取OpenClaw界面字符串
node scripts/extract-strings.js

# 2. 过滤真正的界面文本
node scripts/filter-real-ui.js

# 3. 翻译剩余的字符串
# 编辑 translations/ui-only.json
🛠️ 工具说明
scripts/extract-strings.js
从 OpenClaw 源代码中提取所有可翻译的字符串。

scripts/filter-real-ui.js
智能过滤出真正的界面文本，排除代码片段和变量名。

scripts/smart-translate.js
应用技术术语词典和简单翻译规则进行批量翻译。

📁 项目结构
extensions/openclaw-zh-cn-ui/
├── README.md                    # 项目说明
├── translations/
│   ├── zh-CN.json              # 核心翻译（70个）
│   ├── ui-only.json            # 所有界面文本（441个）
│   ├── code-only.json          # 代码片段（参考）
│   └── extracted-strings.json  # 原始提取结果
├── scripts/
│   ├── extract-strings.js      # 字符串提取
│   ├── filter-real-ui.js       # 界面文本过滤
│   └── smart-translate.js      # 智能翻译
└── docs/
    ├── CONTRIBUTING.md         # 贡献指南
    ├── IMPLEMENTATION.md       # 集成方案
    └── ROADMAP.md              # 路线图
🤝 如何贡献
报告问题：在 Issues 中报告翻译错误或建议
提交翻译：编辑 translations/ui-only.json 文件
改进工具：优化脚本和工具
文档贡献：完善使用文档
详细指南请参阅：CONTRIBUTING.md

🔧 集成到 OpenClaw
要将中文界面集成到 OpenClaw 中，需要：

前端国际化：使用 i18next 或类似库
CLI 本地化：修改 CLI 输出逻辑
构建系统：集成翻译文件到构建流程
详细技术方案请参阅：IMPLEMENTATION.md

📈 路线图
短期目标（1-2周）
完成剩余 371 个界面文本翻译
创建测试页面验证翻译效果
提交 Pull Request 到 OpenClaw 主仓库
中期目标（1个月）
实现前端 i18n 集成
添加语言切换功能
翻译 CLI 输出和错误消息
长期目标
支持更多语言（繁体中文、日语、韩语等）
创建翻译管理平台
自动化翻译工作流
📞 联系与支持
GitHub Issues：问题反馈和功能请求
Discord 社区：实时讨论和协作
邮件列表：项目更新通知
📄 许可证
本项目采用 MIT 许可证。详见 LICENSE 文件。

🙏 致谢
感谢所有为 OpenClaw 中文界面做出贡献的志愿者！

最后更新：2026-02-16
维护者：OpenClaw 中文社区
