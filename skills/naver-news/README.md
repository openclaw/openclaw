# 📰 Naver News Search

Search Korean news articles using the Naver Search API.

## What is this?

This skill enables OpenClaw agents to search, filter, and collect Korean news articles from Naver News. It's designed for building automated workflows like daily news summaries, topic monitoring, and news aggregation.

## Key Capabilities

- Search news by keywords with relevance or date-based sorting
- Filter articles by publication time to avoid duplicates
- Auto-pagination to ensure sufficient results
- JSON output for easy integration with automation systems
- Support for up to 25,000 API calls per day

## Use Cases

- **Daily news summaries**: Automatically collect and curate news across multiple topics
- **Topic monitoring**: Track specific subjects with time-based filtering
- **Breaking news alerts**: Monitor recent articles in near real-time
- **Custom news feeds**: Aggregate news for specific interests

## Documentation

- **[SKILL.md](SKILL.md)** - Complete technical reference and usage guide
- **[examples/daily-summary.md](examples/daily-summary.md)** - Real-world automation workflow
- **[references/api.md](references/api.md)** - Naver News API documentation

## Getting Started

See [SKILL.md](SKILL.md) for setup instructions, API credentials, and detailed usage examples.

## Real-World Example

The [examples/daily-summary.md](examples/daily-summary.md) document shows a complete production workflow that collects 100+ articles, filters by time, selects top stories using priority criteria, and formats them as a daily summary. This is the actual workflow used for automated morning news digests.
