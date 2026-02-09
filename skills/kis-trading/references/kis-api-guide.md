# KIS Open API 엔드포인트 레퍼런스

## 기본 정보
- 실전: `https://openapi.koreainvestment.com:9443`
- 모의: `https://openapivts.koreainvestment.com:29443`
- 인증: OAuth2 Bearer Token (`/oauth2/tokenP`)
- 속도 제한: 초당 20건

## 인증
| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/oauth2/tokenP` | POST | 액세스 토큰 발급 |
| `/uapi/hashkey` | POST | 주문용 해시키 발급 |

## 시세 조회 (GET)
| 엔드포인트 | TR ID | 설명 |
|---|---|---|
| `/uapi/domestic-stock/v1/quotations/inquire-price` | FHKST01010100 | 주식 현재가 시세 |
| `/uapi/domestic-stock/v1/quotations/inquire-ccnl` | FHKST01010300 | 현재가 체결 (최근 30건) |
| `/uapi/domestic-stock/v1/quotations/inquire-daily-price` | FHKST01010400 | 일자별 시세 (최근 30일) |
| `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` | FHKST03010100 | 기간별 시세 (일/주/월/년) |
| `/uapi/domestic-stock/v1/quotations/inquire-index-price` | FHPUP02100000 | 업종 지수 |
| `/uapi/domestic-stock/v1/quotations/volume-rank` | FHPST01710000 | 거래량 순위 |

## 계좌 조회 (GET)
| 엔드포인트 | TR ID | 설명 |
|---|---|---|
| `/uapi/domestic-stock/v1/trading/inquire-balance` | TTTC8434R | 주식 잔고 조회 |
| `/uapi/domestic-stock/v1/trading/inquire-psbl-order` | TTTC8908R | 매수 가능 조회 |
| `/uapi/domestic-stock/v1/trading/inquire-daily-ccld` | TTTC0081R | 일별 주문체결 (3개월 이내) |
| `/uapi/domestic-stock/v1/trading/inquire-daily-ccld` | CTSC9215R | 일별 주문체결 (3개월 이전) |
| `/uapi/domestic-stock/v1/trading/inquire-balance-rlz-pl` | TTTC8494R | 실현손익 조회 |
| `/uapi/domestic-stock/v1/trading/inquire-period-profit` | TTTC8708R | 기간별 손익 |

## 주문 (POST)
| 엔드포인트 | TR ID | 설명 |
|---|---|---|
| `/uapi/domestic-stock/v1/trading/order-cash` | TTTC0012U | 현금 매수 |
| `/uapi/domestic-stock/v1/trading/order-cash` | TTTC0011U | 현금 매도 |
| `/uapi/domestic-stock/v1/trading/order-rvsecncl` | TTTC0013U | 정정/취소 |

### 모의투자 TR ID
| 실전 | 모의 | 설명 |
|---|---|---|
| TTTC0012U | VTTC0802U | 매수 |
| TTTC0011U | VTTC0801U | 매도 |

## 주문구분 코드 (ORD_DVSN)
- `00`: 지정가
- `01`: 시장가
- `02`: 조건부지정가
- `03`: 최유리지정가
- `04`: 최우선지정가

## KRX 호가단위
| 가격 범위 | 호가단위 |
|---|---|
| ~1,000원 | 1원 |
| ~5,000원 | 5원 |
| ~10,000원 | 10원 |
| ~50,000원 | 50원 |
| ~100,000원 | 100원 |
| ~500,000원 | 500원 |
| 500,000원~ | 1,000원 |

## 공통 헤더
```
Content-Type: application/json; charset=utf-8
authorization: Bearer {access_token}
appkey: {APP_KEY}
appsecret: {APP_SECRET}
tr_id: {TR_ID}
custtype: P
```

## 페이징
- `tr_cont`: 연속 거래 키 (D/E: 마지막, F/M: 다음 페이지 존재)
- `CTX_AREA_FK100`, `CTX_AREA_NK100`: 연속 조회 키
