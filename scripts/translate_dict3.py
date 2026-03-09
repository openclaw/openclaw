"""Final pass - fix remaining Korean fragments."""
import re, os

os.chdir(r"C:\TEST\M.AI.UPbit")
KOREAN_RE = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")

DICT = {
    # app.py
    "week기 값 input": "interval value input",
    "current price이 Bollinger": "current price is above Bollinger",
    "모델을 사용한 price": "model for price",
    "list트 전달": "list",
    "거래 tab": "trading tab",

    # cli.py
    "analysis 엔진": "analysis engine",
    "모델 타입": "model type",

    # test_analysis.py
    "데이터에 따라": "depending on data",
    "데이터가": "if data is",
    "기본 provider는": "default provider is",
    "config 시": "config sets",
    "모델": "model",
    "표준": "standard",
    "기본": "default",
    "로": " via",
    "시": " on",
}

ITEMS = sorted(DICT.items(), key=lambda x: len(x[0]), reverse=True)
targets = ["app.py", "maiupbit/cli.py", "tests/unit/test_analysis.py"]

for path in targets:
    with open(path, encoding="utf-8", errors="replace") as f:
        content = f.read()
    for kor, eng in ITEMS:
        content = content.replace(kor, eng)
    remaining = sum(1 for l in content.splitlines() if KOREAN_RE.search(l))
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"{path}: {remaining} Korean lines remaining")
    if remaining:
        for i, line in enumerate(content.splitlines()):
            if KOREAN_RE.search(line):
                print(f"  L{i+1}: {line.strip()[:100]}")
