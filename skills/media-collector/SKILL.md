# Media Collector Skill

自动化、高质量的媒体内容收集工具，支持 RSS、Twitter、Hacker News、Reddit 等多源聚合。

## 特性

- 🔄 **自动化收集** - 定时任务自动抓取
- 📰 **多源支持** - RSS、Twitter、HN、Reddit、YouTube
- 🎯 **智能过滤** - 基于关键词、热度、质量评分
- 💾 **本地存储** - Markdown + JSON 双格式保存
- 🔍 **全文搜索** - 快速检索历史内容
- 📊 **质量评分** - 自动评估内容价值

## 安装

```bash
# 克隆技能
cd <workspace-path>/skills
git clone <repo-url> media-collector

# 安装依赖
pip install -r media-collector/requirements.txt
```

## 快速开始

```bash
# 收集 Hacker News 热门
./media-collector.sh hn --limit 10

# 收集 Twitter 特定话题
./media-collector.sh twitter --query "AI" --limit 20

# 收集 RSS 订阅源
./media-collector.sh rss --config config/sources.json

# 生成每日摘要
./media-collector.sh digest --date today
```

## 配置

编辑 `config/sources.json` 添加你的订阅源：

```json
{
  "rss": [
    {"name": "Hacker News", "url": "https://news.ycombinator.com/rss", "enabled": true},
    {"name": "TechCrunch", "url": "https://techcrunch.com/feed/", "enabled": true}
  ],
  "twitter": {
    "keywords": ["AI", "MachineLearning", "OpenAI"],
    "accounts": ["elonmusk", "sama", "AnthropicAI"]
  },
  "filters": {
    "min_score": 50,
    "keywords_include": ["AI", "tech"],
    "keywords_exclude": ["spam", "ad"]
  }
}
```

## 输出格式

收集的内容保存在 `output/` 目录：

```
output/
├── 2026-02-27/
│   ├── hn_top_10.md
│   ├── twitter_AI.md
│   └── digest.md
├── archive/
│   └── ...
└── index.json
```

## 定时任务

添加到 crontab：

```bash
# 每小时收集 HN 热门
0 * * * * <workspace-path>/skills/media-collector/media-collector.sh hn --limit 20

# 每天上午 9 点生成摘要
0 9 * * * <workspace-path>/skills/media-collector/media-collector.sh digest --date yesterday
```

## API

```python
from src.collector import MediaCollector

collector = MediaCollector()

# 收集 HN
items = collector.collect_hn(limit=10, min_score=100)

# 收集 Twitter
tweets = collector.collect_twitter(query="AI", limit=20)

# 质量评分
score = collector.evaluate_quality(item)

# 保存到本地
collector.save(items, output_dir="output/2026-02-27")
```

## 质量评估标准

- **热度分数** - upvotes/likes/retweets 数量
- **时效性** - 发布时间权重
- **来源可信度** - 来源权威性评分
- **内容长度** - 避免过短/ spam 内容
- **互动率** - 评论/分享比例

## 相关技能

- [`agent-memory`](../agent-memory/) - 持久化存储
- [`brave-search`](../brave-search/) - 网络搜索
- [`summarize`](../summarize/) - 内容摘要
