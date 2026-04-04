---
name: "multi-search-engine"
description: "Multi search engine integration with 17 engines (8 CN + 9 Global). Supports advanced search operators, time filters, site search, privacy engines, and WolframAlpha knowledge queries. No API keys required."
---

# Multi Search Engine v2.0.1

Integration of 17 search engines for web crawling without API keys.

## Search Engines

### Domestic (8)

- **Baidu**: `https://www.baidu.com/s?wd={keyword}`
- **Bing CN**: `https://cn.bing.com/search?q={keyword}&ensearch=0`
- **Bing INT**: `https://cn.bing.com/search?q={keyword}&ensearch=1`
- **360**: `https://www.so.com/s?q={keyword}`
- **Sogou**: `https://sogou.com/web?query={keyword}`
- **WeChat**: `https://wx.sogou.com/weixin?type=2&query={keyword}`
- **Toutiao**: `https://so.toutiao.com/search?keyword={keyword}`
- **Jisilu**: `https://www.jisilu.cn/explore/?keyword={keyword}`

### International (9)

- **Google**: `https://www.google.com/search?q={keyword}`
- **Google HK**: `https://www.google.com.hk/search?q={keyword}`
- **DuckDuckGo**: `https://duckduckgo.com/html/?q={keyword}`
- **Yahoo**: `https://search.yahoo.com/search?p={keyword}`
- **Startpage**: `https://www.startpage.com/sp/search?query={keyword}`
- **Brave**: `https://search.brave.com/search?q={keyword}`
- **Ecosia**: `https://www.ecosia.org/search?q={keyword}`
- **Qwant**: `https://www.qwant.com/?q={keyword}`
- **WolframAlpha**: `https://www.wolframalpha.com/input?i={keyword}`

## Quick Examples

```javascript
// Basic search
web_fetch({ url: "https://www.google.com/search?q=python+tutorial" });

// Site-specific
web_fetch({ url: "https://www.google.com/search?q=site:github.com+react" });

// File type
web_fetch({ url: "https://www.google.com/search?q=machine+learning+filetype:pdf" });

// Time filter (past week)
web_fetch({ url: "https://www.google.com/search?q=ai+news&tbs=qdr:w" });

// Privacy search
web_fetch({ url: "https://duckduckgo.com/html/?q=privacy+tools" });

// DuckDuckGo Bangs
web_fetch({ url: "https://duckduckgo.com/html/?q=!gh+tensorflow" });

// Knowledge calculation
web_fetch({ url: "https://www.wolframalpha.com/input?i=100+USD+to+CNY" });
```

## Advanced Operators

| Operator    | Example                  | Description        |
| ----------- | ------------------------ | ------------------ |
| `site:`     | `site:github.com python` | Search within site |
| `filetype:` | `filetype:pdf report`    | Specific file type |
| `""`        | `"machine learning"`     | Exact match        |
| `-`         | `python -snake`          | Exclude term       |
| `OR`        | `cat OR dog`             | Either term        |

## Time Filters

| Parameter   | Description |
| ----------- | ----------- |
| `tbs=qdr:h` | Past hour   |
| `tbs=qdr:d` | Past day    |
| `tbs=qdr:w` | Past week   |
| `tbs=qdr:m` | Past month  |
| `tbs=qdr:y` | Past year   |

## Privacy Engines

- **DuckDuckGo**: No tracking
- **Startpage**: Google results + privacy
- **Brave**: Independent index
- **Qwant**: EU GDPR compliant

## Bangs Shortcuts (DuckDuckGo)

| Bang  | Destination    |
| ----- | -------------- |
| `!g`  | Google         |
| `!gh` | GitHub         |
| `!so` | Stack Overflow |
| `!w`  | Wikipedia      |
| `!yt` | YouTube        |

## WolframAlpha Queries

- Math: `integrate x^2 dx`
- Conversion: `100 USD to CNY`
- Stocks: `AAPL stock`
- Weather: `weather in Beijing`

## Documentation

- `references/advanced-search.md` - Domestic search guide
- `references/international-search.md` - International search guide
- `CHANGELOG.md` - Version history

## License

MIT
