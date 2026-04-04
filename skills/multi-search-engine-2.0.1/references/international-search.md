# 国际搜索引擎深度搜索指南

## 🔍 Google 深度搜索

### 1.1 基础高级搜索操作符

| 操作符 | 功能       | 示例                                | URL                                                                 |
| ------ | ---------- | ----------------------------------- | ------------------------------------------------------------------- |
| `""`   | 精确匹配   | `"machine learning"`                | `https://www.google.com/search?q=%22machine+learning%22`            |
| `-`    | 排除关键词 | `python -snake`                     | `https://www.google.com/search?q=python+-snake`                     |
| `OR`   | 或运算     | `machine learning OR deep learning` | `https://www.google.com/search?q=machine+learning+OR+deep+learning` |
| `*`    | 通配符     | `machine * algorithms`              | `https://www.google.com/search?q=machine+*+algorithms`              |
| `()`   | 分组       | `(apple OR microsoft) phones`       | `https://www.google.com/search?q=(apple+OR+microsoft)+phones`       |
| `..`   | 数字范围   | `laptop $500..$1000`                | `https://www.google.com/search?q=laptop+%24500..%241000`            |

### 1.2 站点与文件搜索

| 操作符      | 功能     | 示例                              |
| ----------- | -------- | --------------------------------- |
| `site:`     | 站内搜索 | `site:github.com python projects` |
| `filetype:` | 文件类型 | `filetype:pdf annual report`      |
| `inurl:`    | URL包含  | `inurl:login admin`               |
| `intitle:`  | 标题包含 | `intitle:"index of" mp3`          |
| `intext:`   | 正文包含 | `intext:password filetype:txt`    |
| `cache:`    | 查看缓存 | `cache:example.com`               |
| `related:`  | 相关网站 | `related:github.com`              |
| `info:`     | 网站信息 | `info:example.com`                |

### 1.3 时间筛选参数

| 参数                                          | 含义           | URL示例                                          |
| --------------------------------------------- | -------------- | ------------------------------------------------ |
| `tbs=qdr:h`                                   | 过去1小时      | `https://www.google.com/search?q=news&tbs=qdr:h` |
| `tbs=qdr:d`                                   | 过去24小时     | `https://www.google.com/search?q=news&tbs=qdr:d` |
| `tbs=qdr:w`                                   | 过去1周        | `https://www.google.com/search?q=news&tbs=qdr:w` |
| `tbs=qdr:m`                                   | 过去1月        | `https://www.google.com/search?q=news&tbs=qdr:m` |
| `tbs=qdr:y`                                   | 过去1年        | `https://www.google.com/search?q=news&tbs=qdr:y` |
| `tbs=cdr:1,cd_min:1/1/2024,cd_max:12/31/2024` | 自定义日期范围 | 2024年全年                                       |

### 1.4 语言和地区筛选

| 参数            | 功能         | 示例                                                 |
| --------------- | ------------ | ---------------------------------------------------- |
| `hl=en`         | 界面语言     | `https://www.google.com/search?q=test&hl=en`         |
| `lr=lang_zh-CN` | 搜索结果语言 | `https://www.google.com/search?q=test&lr=lang_zh-CN` |
| `cr=countryCN`  | 国家/地区    | `https://www.google.com/search?q=test&cr=countryCN`  |
| `gl=us`         | 地理位置     | `https://www.google.com/search?q=test&gl=us`         |

### 1.5 特殊搜索类型

| 类型     | URL                                                  | 说明                |
| -------- | ---------------------------------------------------- | ------------------- |
| 图片搜索 | `https://www.google.com/search?q={keyword}&tbm=isch` | `tbm=isch` 表示图片 |
| 新闻搜索 | `https://www.google.com/search?q={keyword}&tbm=nws`  | `tbm=nws` 表示新闻  |
| 视频搜索 | `https://www.google.com/search?q={keyword}&tbm=vid`  | `tbm=vid` 表示视频  |
| 地图搜索 | `https://www.google.com/search?q={keyword}&tbm=map`  | `tbm=map` 表示地图  |
| 购物搜索 | `https://www.google.com/search?q={keyword}&tbm=shop` | `tbm=shop` 表示购物 |
| 图书搜索 | `https://www.google.com/search?q={keyword}&tbm=bks`  | `tbm=bks` 表示图书  |
| 学术搜索 | `https://scholar.google.com/scholar?q={keyword}`     | Google Scholar      |

### 1.6 Google 深度搜索示例

```javascript
// 1. 搜索GitHub上的Python机器学习项目
web_fetch({ url: "https://www.google.com/search?q=site:github.com+python+machine+learning" });

// 2. 搜索2024年的PDF格式机器学习教程
web_fetch({
  url: "https://www.google.com/search?q=machine+learning+tutorial+filetype:pdf&tbs=cdr:1,cd_min:1/1/2024",
});

// 3. 搜索标题包含"tutorial"的Python相关页面
web_fetch({ url: "https://www.google.com/search?q=intitle:tutorial+python" });

// 4. 搜索过去一周的新闻
web_fetch({ url: "https://www.google.com/search?q=AI+breakthrough&tbs=qdr:w&tbm=nws" });

// 5. 搜索中文内容（界面英文，结果中文）
web_fetch({ url: "https://www.google.com/search?q=人工智能&lr=lang_zh-CN&hl=en" });

// 6. 搜索特定价格范围的笔记本电脑
web_fetch({ url: "https://www.google.com/search?q=laptop+%241000..%242000+best+rating" });

// 7. 搜索排除Wikipedia的结果
web_fetch({ url: "https://www.google.com/search?q=python+programming+-wikipedia" });

// 8. 搜索学术文献
web_fetch({ url: "https://scholar.google.com/scholar?q=deep+learning+optimization" });

// 9. 搜索缓存页面（查看已删除内容）
web_fetch({ url: "https://webcache.googleusercontent.com/search?q=cache:example.com" });

// 10. 搜索相关网站
web_fetch({ url: "https://www.google.com/search?q=related:stackoverflow.com" });
```

---

## 🦆 DuckDuckGo 深度搜索

### 2.1 DuckDuckGo 特色功能

| 功能             | 语法       | 示例                                            |
| ---------------- | ---------- | ----------------------------------------------- |
| **Bangs 快捷**   | `!缩写`    | `!g python` → Google搜索                        |
| **密码生成**     | `password` | `https://duckduckgo.com/?q=password+20`         |
| **颜色转换**     | `color`    | `https://duckduckgo.com/?q=+%23FF5733`          |
| **短链接**       | `shorten`  | `https://duckduckgo.com/?q=shorten+example.com` |
| **二维码生成**   | `qr`       | `https://duckduckgo.com/?q=qr+hello+world`      |
| **生成UUID**     | `uuid`     | `https://duckduckgo.com/?q=uuid`                |
| **Base64编解码** | `base64`   | `https://duckduckgo.com/?q=base64+hello`        |

### 2.2 DuckDuckGo Bangs 完整列表

#### 搜索引擎

| Bang     | 跳转目标     | 示例                 |
| -------- | ------------ | -------------------- |
| `!g`     | Google       | `!g python tutorial` |
| `!b`     | Bing         | `!b weather`         |
| `!y`     | Yahoo        | `!y finance`         |
| `!sp`    | Startpage    | `!sp privacy`        |
| `!brave` | Brave Search | `!brave tech`        |

#### 编程开发

| Bang      | 跳转目标       | 示例                   |
| --------- | -------------- | ---------------------- |
| `!gh`     | GitHub         | `!gh tensorflow`       |
| `!so`     | Stack Overflow | `!so javascript error` |
| `!npm`    | npmjs.com      | `!npm express`         |
| `!pypi`   | PyPI           | `!pypi requests`       |
| `!mdn`    | MDN Web Docs   | `!mdn fetch api`       |
| `!docs`   | DevDocs        | `!docs python`         |
| `!docker` | Docker Hub     | `!docker nginx`        |

#### 知识百科

| Bang    | 跳转目标      | 示例                           |
| ------- | ------------- | ------------------------------ |
| `!w`    | Wikipedia     | `!w machine learning`          |
| `!wen`  | Wikipedia英文 | `!wen artificial intelligence` |
| `!wt`   | Wiktionary    | `!wt serendipity`              |
| `!imdb` | IMDb          | `!imdb inception`              |

#### 购物价格

| Bang   | 跳转目标   | 示例                     |
| ------ | ---------- | ------------------------ |
| `!a`   | Amazon     | `!a wireless headphones` |
| `!e`   | eBay       | `!e vintage watch`       |
| `!ali` | AliExpress | `!ali phone case`        |

#### 地图位置

| Bang    | 跳转目标      | 示例          |
| ------- | ------------- | ------------- |
| `!m`    | Google Maps   | `!m Beijing`  |
| `!maps` | OpenStreetMap | `!maps Paris` |

### 2.3 DuckDuckGo 搜索参数

| 参数        | 功能         | 示例                                           |
| ----------- | ------------ | ---------------------------------------------- |
| `kp=1`      | 严格安全搜索 | `https://duckduckgo.com/html/?q=test&kp=1`     |
| `kp=-1`     | 关闭安全搜索 | `https://duckduckgo.com/html/?q=test&kp=-1`    |
| `kl=cn`     | 中国区域     | `https://duckduckgo.com/html/?q=news&kl=cn`    |
| `kl=us-en`  | 美国英文     | `https://duckduckgo.com/html/?q=news&kl=us-en` |
| `ia=web`    | 网页结果     | `https://duckduckgo.com/?q=test&ia=web`        |
| `ia=images` | 图片结果     | `https://duckduckgo.com/?q=test&ia=images`     |
| `ia=news`   | 新闻结果     | `https://duckduckgo.com/?q=test&ia=news`       |
| `ia=videos` | 视频结果     | `https://duckduckgo.com/?q=test&ia=videos`     |

### 2.4 DuckDuckGo 深度搜索示例

```javascript
// 1. 使用Bang跳转到Google搜索
web_fetch({ url: "https://duckduckgo.com/html/?q=!g+machine+learning" });

// 2. 直接搜索GitHub上的项目
web_fetch({ url: "https://duckduckgo.com/html/?q=!gh+react" });

// 3. 查找Stack Overflow答案
web_fetch({ url: "https://duckduckgo.com/html/?q=!so+python+list+comprehension" });

// 4. 生成密码
web_fetch({ url: "https://duckduckgo.com/?q=password+16" });

// 5. Base64编码
web_fetch({ url: "https://duckduckgo.com/?q=base64+hello+world" });

// 6. 颜色代码转换
web_fetch({ url: "https://duckduckgo.com/?q=%23FF5733" });

// 7. 搜索YouTube视频
web_fetch({ url: "https://duckduckgo.com/html/?q=!yt+python+tutorial" });

// 8. 查看Wikipedia
web_fetch({ url: "https://duckduckgo.com/html/?q=!w+artificial+intelligence" });

// 9. 亚马逊商品搜索
web_fetch({ url: "https://duckduckgo.com/html/?q=!a+laptop" });

// 10. 生成二维码
web_fetch({ url: "https://duckduckgo.com/?q=qr+https://github.com" });
```

---

## 🔎 Brave Search 深度搜索

### 3.1 Brave Search 特色功能

| 功能            | 参数              | 示例             |
| --------------- | ----------------- | ---------------- |
| **独立索引**    | 无依赖Google/Bing | 自有爬虫索引     |
| **Goggles**     | 自定义搜索规则    | 创建个性化过滤器 |
| **Discussions** | 论坛讨论搜索      | 聚合Reddit等论坛 |
| **News**        | 新闻聚合          | 独立新闻索引     |

### 3.2 Brave Search 参数

| 参数                | 功能     | 示例                                                       |
| ------------------- | -------- | ---------------------------------------------------------- |
| `tf=pw`             | 本周     | `https://search.brave.com/search?q=news&tf=pw`             |
| `tf=pm`             | 本月     | `https://search.brave.com/search?q=tech&tf=pm`             |
| `tf=py`             | 本年     | `https://search.brave.com/search?q=AI&tf=py`               |
| `safesearch=strict` | 严格安全 | `https://search.brave.com/search?q=test&safesearch=strict` |
| `source=web`        | 网页搜索 | 默认                                                       |
| `source=news`       | 新闻搜索 | `https://search.brave.com/search?q=tech&source=news`       |
| `source=images`     | 图片搜索 | `https://search.brave.com/search?q=cat&source=images`      |
| `source=videos`     | 视频搜索 | `https://search.brave.com/search?q=music&source=videos`    |

### 3.3 Brave Search Goggles（自定义过滤器）

Goggles 允许创建自定义搜索规则：

```
$discard  // 丢弃所有
$boost,site=stackoverflow.com  // 提升Stack Overflow
$boost,site=github.com  // 提升GitHub
$boost,site=docs.python.org  // 提升Python文档
```

### 3.4 Brave Search 深度搜索示例

```javascript
// 1. 本周科技新闻
web_fetch({ url: "https://search.brave.com/search?q=technology&tf=pw&source=news" });

// 2. 本月AI发展
web_fetch({ url: "https://search.brave.com/search?q=artificial+intelligence&tf=pm" });

// 3. 图片搜索
web_fetch({ url: "https://search.brave.com/search?q=machine+learning&source=images" });

// 4. 视频教程
web_fetch({ url: "https://search.brave.com/search?q=python+tutorial&source=videos" });

// 5. 使用独立索引搜索
web_fetch({ url: "https://search.brave.com/search?q=privacy+tools" });
```

---

## 📊 WolframAlpha 知识计算搜索

### 4.1 WolframAlpha 数据类型

| 类型         | 查询示例                                  | URL                                                        |
| ------------ | ----------------------------------------- | ---------------------------------------------------------- |
| **数学计算** | `integrate x^2 dx`                        | `https://www.wolframalpha.com/input?i=integrate+x%5E2+dx`  |
| **单位换算** | `100 miles to km`                         | `https://www.wolframalpha.com/input?i=100+miles+to+km`     |
| **货币转换** | `100 USD to CNY`                          | `https://www.wolframalpha.com/input?i=100+USD+to+CNY`      |
| **股票数据** | `AAPL stock`                              | `https://www.wolframalpha.com/input?i=AAPL+stock`          |
| **天气查询** | `weather in Beijing`                      | `https://www.wolframalpha.com/input?i=weather+in+Beijing`  |
| **人口数据** | `population of China`                     | `https://www.wolframalpha.com/input?i=population+of+China` |
| **化学元素** | `properties of gold`                      | `https://www.wolframalpha.com/input?i=properties+of+gold`  |
| **营养成分** | `nutrition of apple`                      | `https://www.wolframalpha.com/input?i=nutrition+of+apple`  |
| **日期计算** | `days between Jan 1 2020 and Dec 31 2024` | 日期间隔计算                                               |
| **时区转换** | `10am Beijing to New York`                | 时区转换                                                   |
| **IP地址**   | `8.8.8.8`                                 | IP信息查询                                                 |
| **条形码**   | `scan barcode 123456789`                  | 条码信息                                                   |
| **飞机航班** | `flight AA123`                            | 航班信息                                                   |

### 4.2 WolframAlpha 深度搜索示例

```javascript
// 1. 计算积分
web_fetch({ url: "https://www.wolframalpha.com/input?i=integrate+sin%28x%29+from+0+to+pi" });

// 2. 解方程
web_fetch({ url: "https://www.wolframalpha.com/input?i=solve+x%5E2-5x%2B6%3D0" });

// 3. 货币实时汇率
web_fetch({ url: "https://www.wolframalpha.com/input?i=100+USD+to+CNY" });

// 4. 股票实时数据
web_fetch({ url: "https://www.wolframalpha.com/input?i=Apple+stock+price" });

// 5. 城市天气
web_fetch({ url: "https://www.wolframalpha.com/input?i=weather+in+Shanghai+tomorrow" });

// 6. 国家统计信息
web_fetch({ url: "https://www.wolframalpha.com/input?i=GDP+of+China+vs+USA" });

// 7. 化学计算
web_fetch({ url: "https://www.wolframalpha.com/input?i=molar+mass+of+H2SO4" });

// 8. 物理常数
web_fetch({ url: "https://www.wolframalpha.com/input?i=speed+of+light" });

// 9. 营养信息
web_fetch({ url: "https://www.wolframalpha.com/input?i=calories+in+banana" });

// 10. 历史日期
web_fetch({ url: "https://www.wolframalpha.com/input?i=events+on+July+20+1969" });
```

---

## 🔧 Startpage 隐私搜索

### 5.1 Startpage 特色功能

| 功能         | 说明             | URL            |
| ------------ | ---------------- | -------------- |
| **代理浏览** | 匿名访问搜索结果 | 点击"匿名查看" |
| **无追踪**   | 不记录搜索历史   | 默认开启       |
| **EU服务器** | 受欧盟隐私法保护 | 数据在欧洲     |
| **代理图片** | 图片代理加载     | 隐藏IP         |

### 5.2 Startpage 参数

| 参数               | 功能               | 示例                   |
| ------------------ | ------------------ | ---------------------- |
| `cat=web`          | 网页搜索           | 默认                   |
| `cat=images`       | 图片搜索           | `...&cat=images`       |
| `cat=video`        | 视频搜索           | `...&cat=video`        |
| `cat=news`         | 新闻搜索           | `...&cat=news`         |
| `language=english` | 英文结果           | `...&language=english` |
| `time=day`         | 过去24小时         | `...&time=day`         |
| `time=week`        | 过去一周           | `...&time=week`        |
| `time=month`       | 过去一月           | `...&time=month`       |
| `time=year`        | 过去一年           | `...&time=year`        |
| `nj=0`             | 关闭 family filter | `...&nj=0`             |

### 5.3 Startpage 深度搜索示例

```javascript
// 1. 隐私搜索
web_fetch({ url: "https://www.startpage.com/sp/search?query=privacy+tools" });

// 2. 图片隐私搜索
web_fetch({ url: "https://www.startpage.com/sp/search?query=nature&cat=images" });

// 3. 本周新闻（隐私模式）
web_fetch({ url: "https://www.startpage.com/sp/search?query=tech+news&time=week&cat=news" });

// 4. 英文结果搜索
web_fetch({ url: "https://www.startpage.com/sp/search?query=machine+learning&language=english" });
```

---

## 🌍 综合搜索策略

### 6.1 按搜索目标选择引擎

| 搜索目标     | 首选引擎       | 备选引擎                | 原因         |
| ------------ | -------------- | ----------------------- | ------------ |
| **学术研究** | Google Scholar | Google, Brave           | 学术资源索引 |
| **编程开发** | Google         | GitHub(DuckDuckGo bang) | 技术文档全面 |
| **隐私敏感** | DuckDuckGo     | Startpage, Brave        | 不追踪用户   |
| **实时新闻** | Brave News     | Google News             | 独立新闻索引 |
| **知识计算** | WolframAlpha   | Google                  | 结构化数据   |
| **中文内容** | Google HK      | Bing                    | 中文优化好   |
| **欧洲视角** | Qwant          | Startpage               | 欧盟合规     |
| **环保支持** | Ecosia         | DuckDuckGo              | 搜索植树     |
| **无过滤**   | Brave          | Startpage               | 无偏见结果   |

### 6.2 多引擎交叉验证

```javascript
// 策略：同一关键词多引擎搜索，对比结果
const keyword = "climate change 2024";

// 获取不同视角
const searches = [
  { engine: "Google", url: `https://www.google.com/search?q=${keyword}&tbs=qdr:m` },
  { engine: "Brave", url: `https://search.brave.com/search?q=${keyword}&tf=pm` },
  { engine: "DuckDuckGo", url: `https://duckduckgo.com/html/?q=${keyword}` },
  { engine: "Ecosia", url: `https://www.ecosia.org/search?q=${keyword}` },
];

// 分析不同引擎的结果差异
```

### 6.3 时间敏感搜索策略

| 时效性要求         | 引擎选择                | 参数设置                |
| ------------------ | ----------------------- | ----------------------- |
| **实时（小时级）** | Google News, Brave News | `tbs=qdr:h`, `tf=pw`    |
| **近期（天级）**   | Google, Brave           | `tbs=qdr:d`, `time=day` |
| **本周**           | 所有引擎                | `tbs=qdr:w`, `tf=pw`    |
| **本月**           | 所有引擎                | `tbs=qdr:m`, `tf=pm`    |
| **历史**           | Google Scholar          | 学术档案                |

### 6.4 专业领域深度搜索

#### 技术开发

```javascript
// GitHub 项目搜索
web_fetch({ url: "https://duckduckgo.com/html/?q=!gh+tensorflow+stars:%3E1000" });

// Stack Overflow 问题
web_fetch({ url: "https://duckduckgo.com/html/?q=!so+python+memory+leak" });

// MDN 文档
web_fetch({ url: "https://duckduckgo.com/html/?q=!mdn+javascript+async+await" });

// PyPI 包
web_fetch({ url: "https://duckduckgo.com/html/?q=!pypi+requests" });

// npm 包
web_fetch({ url: "https://duckduckgo.com/html/?q=!npm+express" });
```

#### 学术研究

```javascript
// Google Scholar 论文
web_fetch({ url: "https://scholar.google.com/scholar?q=deep+learning+2024" });

// 搜索PDF论文
web_fetch({ url: "https://www.google.com/search?q=machine+learning+filetype:pdf+2024" });

// arXiv 论文
web_fetch({ url: "https://duckduckgo.com/html/?q=site:arxiv.org+quantum+computing" });
```

#### 金融投资

```javascript
// 股票实时数据
web_fetch({ url: "https://www.wolframalpha.com/input?i=AAPL+stock" });

// 汇率转换
web_fetch({ url: "https://www.wolframalpha.com/input?i=EUR+to+USD" });

// 搜索财报PDF
web_fetch({ url: "https://www.google.com/search?q=Apple+Q4+2024+earnings+filetype:pdf" });
```

#### 新闻时事

```javascript
// Google新闻
web_fetch({ url: "https://www.google.com/search?q=breaking+news&tbm=nws&tbs=qdr:h" });

// Brave新闻
web_fetch({ url: "https://search.brave.com/search?q=world+news&source=news" });

// DuckDuckGo新闻
web_fetch({ url: "https://duckduckgo.com/html/?q=tech+news&ia=news" });
```

---

## 🛠️ 高级搜索技巧汇总

### URL编码工具函数

```javascript
// URL编码关键词
function encodeKeyword(keyword) {
  return encodeURIComponent(keyword);
}

// 示例
const keyword = "machine learning";
const encoded = encodeKeyword(keyword); // "machine%20learning"
```

### 批量搜索模板

```javascript
// 多引擎批量搜索函数
function generateSearchUrls(keyword) {
  const encoded = encodeURIComponent(keyword);
  return {
    google: `https://www.google.com/search?q=${encoded}`,
    google_hk: `https://www.google.com.hk/search?q=${encoded}`,
    duckduckgo: `https://duckduckgo.com/html/?q=${encoded}`,
    brave: `https://search.brave.com/search?q=${encoded}`,
    startpage: `https://www.startpage.com/sp/search?query=${encoded}`,
    bing_intl: `https://cn.bing.com/search?q=${encoded}&ensearch=1`,
    yahoo: `https://search.yahoo.com/search?p=${encoded}`,
    ecosia: `https://www.ecosia.org/search?q=${encoded}`,
    qwant: `https://www.qwant.com/?q=${encoded}`,
  };
}

// 使用示例
const urls = generateSearchUrls("artificial intelligence");
```

### 时间筛选快捷函数

```javascript
// Google时间筛选URL生成
function googleTimeSearch(keyword, period) {
  const periods = {
    hour: "qdr:h",
    day: "qdr:d",
    week: "qdr:w",
    month: "qdr:m",
    year: "qdr:y",
  };
  return `https://www.google.com/search?q=${encodeURIComponent(keyword)}&tbs=${periods[period]}`;
}

// 使用示例
const recentNews = googleTimeSearch("AI breakthrough", "week");
```

---

## 📝 完整搜索示例集

```javascript
// ==================== 技术开发 ====================

// 1. 搜索GitHub上高Star的Python项目
web_fetch({ url: "https://www.google.com/search?q=site:github.com+python+stars:%3E1000" });

// 2. Stack Overflow最佳答案
web_fetch({ url: "https://duckduckgo.com/html/?q=!so+best+way+to+learn+python" });

// 3. MDN文档查询
web_fetch({ url: "https://duckduckgo.com/html/?q=!mdn+promises" });

// 4. 搜索npm包
web_fetch({ url: "https://duckduckgo.com/html/?q=!npm+axios" });

// ==================== 学术研究 ====================

// 5. Google Scholar论文
web_fetch({ url: "https://scholar.google.com/scholar?q=transformer+architecture" });

// 6. 搜索PDF论文
web_fetch({ url: "https://www.google.com/search?q=attention+is+all+you+need+filetype:pdf" });

// 7. arXiv最新论文
web_fetch({ url: "https://duckduckgo.com/html/?q=site:arxiv.org+abs+quantum" });

// ==================== 新闻时事 ====================

// 8. Google最新新闻（过去1小时）
web_fetch({ url: "https://www.google.com/search?q=breaking+news&tbs=qdr:h&tbm=nws" });

// 9. Brave本周科技新闻
web_fetch({ url: "https://search.brave.com/search?q=technology&tf=pw&source=news" });

// 10. DuckDuckGo新闻
web_fetch({ url: "https://duckduckgo.com/html/?q=world+news&ia=news" });

// ==================== 金融投资 ====================

// 11. 股票实时数据
web_fetch({ url: "https://www.wolframalpha.com/input?i=Tesla+stock" });

// 12. 货币汇率
web_fetch({ url: "https://www.wolframalpha.com/input?i=1+BTC+to+USD" });

// 13. 公司财报PDF
web_fetch({ url: "https://www.google.com/search?q=Microsoft+annual+report+2024+filetype:pdf" });

// ==================== 知识计算 ====================

// 14. 数学计算
web_fetch({ url: "https://www.wolframalpha.com/input?i=derivative+of+x%5E3+sin%28x%29" });

// 15. 单位换算
web_fetch({ url: "https://www.wolframalpha.com/input?i=convert+100+miles+to+kilometers" });

// 16. 营养信息
web_fetch({ url: "https://www.wolframalpha.com/input?i=protein+in+chicken+breast" });

// ==================== 隐私保护搜索 ====================

// 17. DuckDuckGo隐私搜索
web_fetch({ url: "https://duckduckgo.com/html/?q=privacy+tools" });

// 18. Startpage匿名搜索
web_fetch({ url: "https://www.startpage.com/sp/search?query=secure+messaging" });

// 19. Brave无追踪搜索
web_fetch({ url: "https://search.brave.com/search?q=encryption+software" });

// ==================== 高级组合搜索 ====================

// 20. Google多条件精确搜索
web_fetch({
  url: "https://www.google.com/search?q=%22machine+learning%22+site:github.com+filetype:pdf+2024",
});

// 21. 排除特定站点的搜索
web_fetch({ url: "https://www.google.com/search?q=python+tutorial+-wikipedia+-w3schools" });

// 22. 价格范围搜索
web_fetch({ url: "https://www.google.com/search?q=laptop+%24800..%241200+best+review" });

// 23. 使用Bangs快速跳转
web_fetch({ url: "https://duckduckgo.com/html/?q=!g+site:medium.com+python" });

// 24. 图片搜索（Google）
web_fetch({ url: "https://www.google.com/search?q=beautiful+landscape&tbm=isch" });

// 25. 学术引用搜索
web_fetch({ url: "https://scholar.google.com/scholar?q=author:%22Geoffrey+Hinton%22" });
```

---

## 🔐 隐私保护最佳实践

### 搜索引擎隐私级别

| 引擎           | 追踪级别 | 数据保留 | 加密 | 推荐场景                 |
| -------------- | -------- | -------- | ---- | ------------------------ |
| **DuckDuckGo** | 无追踪   | 无保留   | 是   | 日常隐私搜索             |
| **Startpage**  | 无追踪   | 无保留   | 是   | 需要Google结果但保护隐私 |
| **Brave**      | 无追踪   | 无保留   | 是   | 独立索引，无偏见         |
| **Qwant**      | 无追踪   | 无保留   | 是   | 欧盟合规要求             |
| **Google**     | 高度追踪 | 长期保留 | 是   | 需要个性化结果           |
| **Bing**       | 中度追踪 | 长期保留 | 是   | 微软服务集成             |

### 隐私搜索建议

1. **日常使用**: DuckDuckGo 或 Brave
2. **需要Google结果但保护隐私**: Startpage
3. **学术研究**: Google Scholar（学术用途追踪较少）
4. **敏感查询**: 使用Tor浏览器 + DuckDuckGo onion服务
5. **跨设备同步**: 避免登录搜索引擎账户

---

## 📚 参考资料

- [Google搜索操作符完整列表](https://support.google.com/websearch/answer/...)
- [DuckDuckGo Bangs完整列表](https://duckduckgo.com/bang)
- [Brave Search文档](https://search.brave.com/help/...)
- [WolframAlpha示例](https://www.wolframalpha.com/examples/)
