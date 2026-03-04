# Media Collector - 媒体收集 OpenClaw 实践

> 自动化、高质量的媒体内容收集工具

## 🎯 目标

创建一个**自动化**、**高质量**的媒体收集系统，支持：
- ✅ 多源聚合（HN、Twitter、Reddit、RSS、YouTube）
- ✅ 智能过滤（关键词、热度、质量评分）
- ✅ 定时任务（cron 自动执行）
- ✅ 本地存储（Markdown + JSON）
- ✅ 快速检索（全文搜索）

## 📦 安装

```bash
# 依赖已安装
cd /Users/aiutb/.openclaw/workspace/skills/media-collector

# 测试安装
./media-collector.sh help
```

## 🚀 快速开始

```bash
# 收集 HN 热门（最低 100 分）
./media-collector.sh hn --limit 20 --min-score 100

# 收集 Twitter AI 相关内容
./media-collector.sh twitter --query "AI" --limit 50

# 生成每日摘要
./media-collector.sh digest --date today

# 查看状态
./media-collector.sh status
```

## 📁 目录结构

```
media-collector/
├── media-collector.sh      # 主入口脚本
├── SKILL.md                # 技能文档
├── config/
│   └── sources.json        # 订阅源配置
├── src/
│   ├── hn_collector.py     # HN 收集器
│   ├── twitter_collector.py
│   ├── reddit_collector.py
│   ├── rss_collector.py
│   ├── youtube_collector.py
│   ├── digest_generator.py
│   ├── search.py
│   └── quality_scorer.py
├── output/
│   ├── 2026-02-27/         # 每日输出
│   └── archive/            # 归档
└── requirements.txt        # Python 依赖
```

## ⚙️ 配置

编辑 `config/sources.json` 自定义：
- RSS 订阅源
- Twitter 关键词/账号
- Reddit 子版块
- HN 过滤条件
- YouTube 频道

## 🔧 定时任务

添加到 crontab (`crontab -e`)：

```bash
# 每小时收集 HN 热门
0 * * * * /Users/aiutb/.openclaw/workspace/skills/media-collector/media-collector.sh hn --limit 20

# 每天 9 点生成摘要
0 9 * * * /Users/aiutb/.openclaw/workspace/skills/media-collector/media-collector.sh digest --date yesterday

# 每天清理 30 天前数据
0 2 * * * /Users/aiutb/.openclaw/workspace/skills/media-collector/media-collector.sh clean
```

## 📊 质量评分标准

| 指标 | 权重 | 说明 |
|------|------|------|
| 热度分数 | 40% | upvotes/likes/retweets |
| 时效性 | 20% | 发布时间（越新越高） |
| 来源可信度 | 20% | 来源权威性 |
| 内容长度 | 10% | 避免过短/spam |
| 互动率 | 10% | 评论/分享比例 |

## 🔍 搜索示例

```bash
# 搜索已收集内容
./media-collector.sh search "machine learning"

# 搜索特定日期
./media-collector.sh search "AI" --date 2026-02-27
```

## 📝 输出格式

**Markdown**（人类可读）：
```markdown
# Hacker News 热门内容

*收集时间：2026-02-27 21:05:03*

## 1. 文章标题

**链接**: [url](url)
**分数**: 2145 | **评论**: 1163
**时间**: 2026-02-27T06:42:47
```

**JSON**（机器可读）：
```json
{
  "collected_at": "2026-02-27T21:05:03",
  "source": "hackernews",
  "count": 3,
  "stories": [...]
}
```

## 🛠️ 扩展

添加新收集器：
1. 在 `src/` 创建 `xxx_collector.py`
2. 实现 `collect()` 和 `save()` 方法
3. 在 `media-collector.sh` 添加命令分支

## 📚 相关技能

- [`agent-memory`](../agent-memory/) - 持久化存储
- [`brave-search`](../brave-search/) - 网络搜索
- [`summarize`](../summarize/) - 内容摘要

## 📄 License

MIT
