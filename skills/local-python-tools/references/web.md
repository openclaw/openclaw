# 网页数据采集工具参考

## requests

基础 HTTP 请求库。

```python
import requests

# GET
r = requests.get("https://example.com", timeout=10)
print(r.status_code)
print(r.text[:500])

# 带参数
params = {"keyword": "股票", "page": 1}
r = requests.get("https://search.example.com", params=params, timeout=10)

# POST
data = {"username": "user", "password": "pass"}
r = requests.post("https://api.example.com/login", data=data)

# 带 Header
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://example.com",
    "Accept": "application/json",
}
r = requests.get(url, headers=headers, timeout=10)

# JSON 响应
data = r.json()
```

---

## curl_cffi

模拟真实浏览器，可绕过普通反爬机制。

```python
from curl_cffi import requests as creq

# 模拟 Chrome 浏览器
r = creq.get(url, impersonate="chrome", timeout=10)

# 模拟 Firefox
r = creq.get(url, impersonate="firefox", timeout=10)

# 带 Cookie
cookies = {"session_id": "abc123"}
r = creq.get(url, cookies=cookies, impersonate="chrome")
```

---

## BeautifulSoup

HTML/XML 解析，配合 requests 使用。

```python
from bs4 import BeautifulSoup
import requests

r = requests.get(url, timeout=10)
soup = BeautifulSoup(r.content, "lxml")       # lxml 引擎（推荐，速度快）
# soup = BeautifulSoup(r.text, "html.parser") # 内置引擎（无需额外安装）
# soup = BeautifulSoup(r.content, "html5lib")  # html5lib（容错最强）
```

### 常用选择器

```python
# 按标签
soup.find("div")              # 第一个 div
soup.find_all("a")           # 所有 a 标签

# 按 class（推荐）
soup.select(".title")         # class="title"
soup.select("div.content")    # div + class

# 按 id
soup.select("#main")

# 按属性
soup.find("a", href=True)     # 所有带 href 的 a
soup.find("a", {"class": "link"})

# 嵌套提取
for item in soup.select(".news-item"):
    title = item.select_one(".title").text.strip()
    link  = item.select_one("a")["href"]
    print(title, link)
```

### 提取文本和属性

```python
soup.get_text(strip=True)     # 所有文本（去首尾空格）
a["href"]                     # 属性值
img["src"]                    # 图片链接
```

---

## 完整采集流程

```python
import requests
from bs4 import BeautifulSoup
import pandas as pd
import time

headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

urls = [
    "https://news.example.com/1",
    "https://news.example.com/2",
    "https://news.example.com/3",
]

results = []
for url in urls:
    try:
        r = requests.get(url, headers=headers, timeout=10)
        soup = BeautifulSoup(r.content, "lxml")
        title = soup.select_one("h1.title").text.strip()
        date  = soup.select_one(".date").text.strip()
        results.append({"标题": title, "日期": date})
        time.sleep(1)  # 礼貌爬取，间隔1秒
    except Exception as e:
        print(f"采集失败 {url}: {e}")

df = pd.DataFrame(results)
df.to_csv("C:\\Users\\Administrator\\Desktop\\news.csv", index=False, encoding="utf-8-sig")
```

---

## JSON 数据处理

```python
import json
import requests

r = requests.get("https://api.example.com/data", timeout=10)
data = r.json()  # 自动解析 JSON

# 写文件
with open("data.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

# 读文件
with open("data.json", "r", encoding="utf-8") as f:
    data = json.load(f)
```

---

## jsonpath 快速提取

```python
import jsonpath

data = {"records": [{"name": "Alice"}, {"name": "Bob"}]}
names = jsonpath.jsonpath(data, "$.records[*].name")  # ["Alice", "Bob"]
```
