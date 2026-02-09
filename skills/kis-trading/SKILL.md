---
name: kis-trading
description: "한국투자증권(KIS) Open API를 이용한 국내 주식 트레이딩. 잔고 조회, 시세 확인, 매수/매도 주문, 매매 내역, 시장 개황 등. | Korean stock trading via KIS (Korea Investment & Securities) Open API. Balance, quotes, buy/sell orders, trade history, market overview."
metadata:
  {
    "openclaw":
      {
        "emoji": "📈",
        "requires": { "bins": ["python3"], "pip": ["requests"] },
        "config_keys": ["KIS_APP_KEY", "KIS_APP_SECRET", "KIS_ACCOUNT_NO", "KIS_BASE_URL"],
      },
  }
---

# KIS 주식 트레이딩

한국투자증권 Open API를 통한 국내 주식 매매 스킬.

Korean stock trading skill using KIS (Korea Investment & Securities) Open API. Supports balance inquiry, real-time quotes, buy/sell orders, trade history, and market overview for stocks listed on KRX (KOSPI/KOSDAQ).

## 설정

config 파일(`~/.kis-trading/config.ini`)에 아래 값을 설정:

```ini
[KIS]
APP_KEY = your_app_key
APP_SECRET = your_app_secret
ACCOUNT_NO = 12345678-01
BASE_URL = https://openapi.koreainvestment.com:9443
# 모의투자: https://openapivts.koreainvestment.com:29443
```

설정 확인:

```bash
python3 scripts/setup.py --config ~/.kis-trading/config.ini --check
```

## 잔고 조회

"잔고 보여줘", "계좌 잔고", "예수금", "매수 가능 금액"

```bash
python3 scripts/balance.py --config ~/.kis-trading/config.ini
```

## 보유 종목

"보유 종목", "내 주식", "수익률"

```bash
python3 scripts/holdings.py --config ~/.kis-trading/config.ini
```

## 종목 시세

"삼성전자 현재가", "005930 시세", "카카오 주가"

```bash
python3 scripts/quote.py --config ~/.kis-trading/config.ini --code 005930
python3 scripts/quote.py --config ~/.kis-trading/config.ini --name 삼성전자
```

## 매수/매도 주문

"삼성전자 10주 매수", "카카오 5주 매도"

⚠️ **주문은 반드시 사용자에게 확인을 받은 후 실행할 것!**

```bash
# 시장가 매수
python3 scripts/order.py --config ~/.kis-trading/config.ini --side buy --code 005930 --qty 10 --market

# 지정가 매수
python3 scripts/order.py --config ~/.kis-trading/config.ini --side buy --code 005930 --qty 10 --price 70000

# 매도
python3 scripts/order.py --config ~/.kis-trading/config.ini --side sell --code 005930 --qty 10 --market
```

주문 전 반드시:
1. 종목명, 수량, 가격을 사용자에게 보여주고 확인 요청
2. `--dry-run` 으로 주문 내용 미리 확인 가능
3. 확인 후 실제 주문 실행

## 매매 내역

"매매 내역", "오늘 체결 내역", "주문 내역"

```bash
python3 scripts/history.py --config ~/.kis-trading/config.ini
python3 scripts/history.py --config ~/.kis-trading/config.ini --start 20240101 --end 20240131
```

## 시장 개황

"시장 개황", "거래량 상위", "코스피 지수"

```bash
python3 scripts/market.py --config ~/.kis-trading/config.ini --action index
python3 scripts/market.py --config ~/.kis-trading/config.ini --action volume-rank
```

## 주의사항

- 실전 투자 시 반드시 BASE_URL을 실전 URL로 설정
- 모의투자와 실전투자의 TR ID가 다를 수 있음
- API 호출은 초당 20건 제한 (자동 제어됨)
- 주문은 **절대** 사용자 확인 없이 실행하지 말 것
