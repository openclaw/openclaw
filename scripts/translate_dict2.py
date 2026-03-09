"""Second pass - translate remaining Korean text with expanded dictionary."""
import re, os

os.chdir(r"C:\TEST\M.AI.UPbit")
KOREAN_RE = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")

DICT = {
    # app.py remaining
    "거래 이력": "trade history",
    "구매 이력을 데이터베이스에": "save buy history to database",
    "판매 이력을 데이터베이스에": "save sell history to database",
    "현재 스크립트 파일의 디렉토리 경로 가져오기": "get directory path of current script file",
    "사이드바에 토스 QR 코드 추가": "add Toss QR code to sidebar",
    "토스로 펀드 받기": "Receive funds via Toss",
    "사이드바에 kakao QR 코드 추가": "add Kakao QR code to sidebar",
    "카카오페이로 펀드 받기": "Receive funds via KakaoPay",
    "개발펀딩": "Dev Funding",
    "레이븐": "Raven",
    "스케줄 주기 선택": "select schedule interval",
    "스케줄 주기": "Schedule Interval",
    "분 간격": "Minute Interval",
    "시간 간격": "Hour Interval",
    "일 간격": "Day Interval",
    "주 간격": "Week Interval",
    "월 간격": "Month Interval",
    "년 간격": "Year Interval",
    "분": "minute",
    "시간": "hour",
    "일": "day",
    "주": "week",
    "월": "month",
    "년": "year",
    "최근": "recent",
    "일 간": "days of",
    "의 profit rate을 record하였습니다": " profit rate recorded",
    "이동평균선이 bullish 배열을 이루고 있으며": "moving averages forming bullish alignment and",
    "볼린저밴드 상한선을": "Bollinger Band upper band",
    "주어진 URL에서 기사 내용을 추출합니다": "Extract article content from given URL",
    "기사 URL": "article URL",
    "기사 내용": "article content",
    "기사 내용을 가져오는 중 error가 발생했습니다": "error occurred while fetching article content",
    "HTML 태그 제거": "remove HTML tags",
    "불필요한 내용 제거": "remove unnecessary content",
    "Google News RSS 피드 URL": "Google News RSS feed URL",
    "피드 파싱": "parse feed",
    "요약 문장 내 줄바꿈 유지": "preserve line breaks in summary",
    "추가: 기사 간 줄바꿈": "add: line break between articles",
    "디버깅": "debugging",
    "뉴스를 가져오는 중 error가 발생했습니다": "error occurred while fetching news",
    "기사별로 분리": "split by article",
    "빈 문자열 제외": "exclude empty strings",
    "기사 간 간격 추가": "add spacing between articles",
    "뉴스와 analysis result 사이 간격 추가": "add spacing between news and analysis result",
    "사용자 정의 CSS 추가": "add custom CSS",
    "기본 스타일": "default styles",
    "화면 너비가 600px 이하일 때 적용되는 스타일": "styles applied when screen width <= 600px",
    "추출": "extract",
    "추가": "add",
    "예측 및 시각화": "prediction and visualization",
    "를 사용하여 데이터 analysis 및 거래 결정": "for data analysis and trade decision",
    "트레이딩 이력 표시": "display trading history",
    "에서 이동된 부분": "moved from",
    "탭": "tab",
    "리스": "list",

    # cli.py remaining
    "등": "etc",
    "추천": "recommend",
    "코드": "code",
    "예": "e.g.",
    "콤마 구분": "comma-separated",
    "AI 디지털 asset anal": "AI digital asset anal",
    "개수": "count",
    "기간": "period",
    "퀀트": "quantitative",
    "명령어": "commands",
    "듀얼": "dual",
    "랭킹": "ranking",
    "다중팩터": "multi-factor",
    "배분": "allocation",
    "정보": "info",
    "모델 학습": "model training",
    "학습 데이터 기간": "training data period",
    "학습 에포크": "training epochs",
    "매매 confirm": "trading confirm",
    "비중 배수": "weight multiplier",
    "반감기 단계": "halving phase",
    "다음 반감기": "next halving",
    "데이터 query failed": "data query failed",
    "관망": "hold",
    "시그널": "signal",
    "최적": "optimal",
    "현금": "cash",
    "샤프비율": "Sharpe ratio",
    "최종asset": "final equity",

    # test_analysis.py remaining
    "를": "",
    "가진": "with",
    "상태를 만들도록 급등하는 데이터": "rapidly rising data to create overbought conditions",
    "상태면": "state then",
    "권장": "recommended",
    "달라질 수 있으므로": "may vary so",
    "기준으로": "based on",
    "해석": "interpretation",
    "너무 적으면": "too few",
    "건너뜀": "skip",
    "언급": "mentioned",
    "세 coin에 서로 다른 profit rate 부여": "assign different profit rates to three coins",
    "리플": "Ripple",
    "수익 1위": "highest profit",
    "유틸리티": "utility",
    "구간 진입": "zone entry",
    "골든크로스 confirm으로 buy 적기": "golden cross confirmed, good time to buy",
    "자본의": "of capital",
    "프로바이더": "provider",
    "모델은": "model is",
    "자동 결정": "auto-determined",
    "문자열": "string",
    "파싱": "parsing",
    "유효한 JSON": "valid JSON",
    "잘못된 JSON": "invalid JSON",
    "마크다운": "markdown",
    "코드 블록 내부 JSON": "JSON inside code block",
    "파싱 불가 문자열": "unparseable string",
    "반환": "return",
    "기존": "existing",
    "필드를": "field to",
    "매핑": "mapping",
    "하위 호환": "backward compatibility",
    "중": "in progress",
    "가 올바른 구조의 result를": "returns correctly structured result",
    "시 기본 hold result": "returns default hold result on",
    "환경 변수로": "via environment variable",
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
