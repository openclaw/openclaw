"""Replace Korean text with English using a dictionary - preserves indentation."""
import re, os

os.chdir(r"C:\TEST\M.AI.UPbit")

# Korean -> English dictionary (common patterns found in code)
DICT = {
    # Comments
    "디버깅 관련 코드": "debugging related code",
    "추천 종목 리스트 표시": "display recommended symbols list",
    "추천 종목": "Recommended Symbols",
    "포트폴리오 데이터 표시": "display portfolio data",
    "추천된 종목이 없습니다": "No recommended symbols",
    "코인 뉴스 가져오기": "fetch coin news",
    "시장 데이터 가져오기": "fetch market data",
    "거래 내역 표시": "display trade history",
    "거래 실행": "execute trade",
    "매수 주문 실행": "execute buy order",
    "매도 주문 실행": "execute sell order",
    "거래 내역 저장": "save trade history",
    "거래 내역 테이블 생성": "create trade history table",
    "거래 내역 조회": "fetch trade history",
    "데이터 가져오기": "fetch data",
    "환경 변수 설정": "set environment variables",
    "종목 선택": "select symbols",
    "자동 거래": "auto trading",
    "스케줄 실행": "scheduled execution",
    "리포트 생성": "generate report",
    "대시보드 표시": "display dashboard",
    "포트폴리오": "portfolio",
    "잔고 조회": "balance check",
    "현재 상태 조회": "get current status",
    "분석 결과": "analysis result",
    "기술 분석": "technical analysis",
    "기술적 분석": "technical analysis",
    "감성 분석": "sentiment analysis",
    "종합 분석": "comprehensive analysis",
    "투자 분석": "investment analysis",
    "매매 신호": "trading signal",
    "매매 결정": "trading decision",
    "매매 실행": "trade execution",
    "매매 기록": "trade record",
    "주문 실행": "order execution",
    "주문 결과": "order result",
    "시장 데이터": "market data",
    "시장 상태": "market status",
    "현재 가격": "current price",
    "평균 매수가": "average buy price",
    "수익률": "profit rate",
    "수량": "quantity",
    "가격": "price",
    "거래량": "volume",
    "변동성": "volatility",
    "모멘텀": "momentum",
    "시즌": "season",
    "돌파": "breakout",
    "추세": "trend",
    "지표": "indicator",
    "지표들": "indicators",
    "신호": "signal",
    "전략": "strategy",
    "백테스트": "backtest",
    "리스크": "risk",
    "포지션": "position",
    "잔고": "balance",
    "자산": "asset",
    "종목": "symbol",
    "코인": "coin",
    "암호화폐": "cryptocurrency",
    "비트코인": "Bitcoin",
    "이더리움": "Ethereum",
    "업비트": "Upbit",
    "분석": "analysis",
    "실행": "execution",
    "기록": "record",
    "설정": "config",
    "확인": "confirm",
    "생성": "create",
    "삭제": "delete",
    "조회": "query",
    "저장": "save",
    "로드": "load",
    "업데이트": "update",
    "초기화": "initialize",
    "성공": "success",
    "실패": "failed",
    "오류": "error",
    "경고": "warning",
    "완료": "completed",
    "시작": "start",
    "종료": "end",
    "결과": "result",
    "입력": "input",
    "출력": "output",
    "테스트": "test",
    "단위 테스트": "unit test",
    "모의 거래소": "mock exchange",
    "가격 데이터": "price data",
    "일봉 데이터": "daily candle data",
    "시간봉 데이터": "hourly candle data",
    "과매수": "overbought",
    "과매도": "oversold",
    "상승": "bullish",
    "하락": "bearish",
    "횡보": "sideways",
    "매수": "buy",
    "매도": "sell",
    "보유": "hold",

    # String literals in app.py
    "선택한 티커:": "Select Ticker:",
    "종목 선택 방법 선택:": "Select a Symbol Selection Method:",
    "선택한 종목": "Select a symbol",
    "종목이 선택되지 않았습니다": "No symbols selected",
    "추천 종목 계산 중": "Calculating recommended symbols",
    "거래를 시작하려면 하나 이상의 종목을 선택하세요": "Please select at least one symbol to start trading",

    # cli.py specific
    "소수점 이하 코인 가격 대응": "handle sub-1 KRW coin prices",
    "예상 수령액": "Estimated receive amount",
    "예상 수량": "Estimated quantity",
    "실행하려면 --confirm 플래그를 추가하세요": "Add --confirm flag to execute",
    "지식 컨텍스트": "knowledge context",
    "분석에 충분한": "sufficient for analysis",
    "꾸준히 하락": "steady decline",
    "급락하는 데이터": "rapidly declining data",

    # test_analysis.py specific
    "단위 테스트": "unit tests",
    "가진 모의 거래소": "mock exchange with",
    "개 OHLCV 데이터": "OHLCV data points",
    "과매도 상태를 만들도록 급락하는 데이터": "rapidly declining data to create oversold conditions",
    "분석에 충분한 100개 OHLCV 데이터": "100 OHLCV data points sufficient for analysis",
    "RSI 과매도 상태를 만들도록": "to create RSI oversold conditions",
    "기본 분석 프롬프트": "default analysis prompt",
    "프롬프트": "prompt",
    "가상 응답": "mock response",
    "응답 파싱": "response parsing",
    "유효한 JSON": "valid JSON",
    "잘못된 JSON": "invalid JSON",
    "분석 수행": "perform analysis",
    "기술 지표 계산": "calculate technical indicators",
    "추천 결과": "recommendation result",
    "에러 처리": "error handling",
    "예외 발생": "exception raised",

    # Common phrases
    "열 계산": "column calculation",
    "열 추가": "column added",
    "테이블이 없으면 생성": "create table if not exists",
    "거래 기록": "trade history",
    "주문 금액": "order amount",
    "Mnemo 지식 컨텍스트": "Mnemo knowledge context",
    "선택된 종목 없음": "no selected symbol",
    "API 키": "API key",
    "환경 변수": "environment variable",
    "자동 매매": "auto trading",
    "수동 매매": "manual trading",
    "스케줄 간격": "schedule interval",
    "거래 유형": "trade type",
}

# Sort by length (longest first) for greedy matching
ITEMS = sorted(DICT.items(), key=lambda x: len(x[0]), reverse=True)
KOREAN_RE = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")

targets = ["app.py", "maiupbit/cli.py", "tests/unit/test_analysis.py"]

for path in targets:
    with open(path, encoding="utf-8", errors="replace") as f:
        content = f.read()

    for kor, eng in ITEMS:
        content = content.replace(kor, eng)

    # Check remaining Korean
    remaining = sum(1 for l in content.splitlines() if KOREAN_RE.search(l))
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"{path}: {remaining} Korean lines remaining")

    # Show remaining Korean lines
    if remaining:
        for i, line in enumerate(content.splitlines()):
            if KOREAN_RE.search(line):
                print(f"  L{i+1}: {line.strip()[:80]}")
