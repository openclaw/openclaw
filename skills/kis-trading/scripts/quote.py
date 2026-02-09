#!/usr/bin/env python3
"""종목 시세 조회"""
from typing import Optional, Dict
import argparse
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from kis_common import load_config, get_token, api_get, fmt_price, fmt_rate, fmt_num, add_common_args, get_stock_name_from_api, safe_int, safe_float

# 주요 종목 이름→코드 매핑 (자주 검색하는 종목)
STOCK_NAME_MAP = {
    '삼성전자': '005930', '삼성전자우': '005935',
    'SK하이닉스': '000660', 'LG에너지솔루션': '373220',
    '삼성바이오로직스': '207940', '현대차': '005380', '현대자동차': '005380',
    '기아': '000270', 'NAVER': '035420', '네이버': '035420',
    '카카오': '035720', '셀트리온': '068270',
    'LG화학': '051910', 'POSCO홀딩스': '005490', '포스코홀딩스': '005490',
    '삼성SDI': '006400', '카카오뱅크': '323410',
    '삼성물산': '028260', '한국전력': '015760',
    'KB금융': '105560', '신한지주': '055550', '하나금융지주': '086790',
    'SK이노베이션': '096770', '두산에너빌리티': '034020',
    '카카오페이': '377300', '크래프톤': '259960',
    '엔씨소프트': '036570', '넷마블': '251270',
    'HD현대중공업': '329180', 'HD한국조선해양': '009540',
    '한화오션': '042660', '대한항공': '003490',
    'HLB': '028300', '에코프로': '086520', '에코프로비엠': '247540',
    '포스코퓨처엠': '003670', '알테오젠': '196170',
}


# 코드→이름 역매핑
STOCK_CODE_MAP = {v: k for k, v in STOCK_NAME_MAP.items()}


def get_stock_name_by_code(code: str) -> Optional[str]:
    """종목코드→이름 변환 (내장 맵 사용)"""
    return STOCK_CODE_MAP.get(code)


def get_quote(cfg: dict, token: str, code: str) -> Optional[dict]:
    """현재가 조회"""
    params = {
        "FID_COND_MRKT_DIV_CODE": "J",
        "FID_INPUT_ISCD": code,
    }
    return api_get(cfg, token, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', params)


def resolve_code(name: str) -> Optional[str]:
    """종목명→코드 변환"""
    # 정확히 일치
    if name in STOCK_NAME_MAP:
        return STOCK_NAME_MAP[name]
    # 부분 일치
    for k, v in STOCK_NAME_MAP.items():
        if name in k or k in name:
            return v
    return None


def main():
    parser = argparse.ArgumentParser(description='종목 시세 조회')
    add_common_args(parser)
    parser.add_argument('--code', help='종목코드 (6자리)')
    parser.add_argument('--name', help='종목명 (예: 삼성전자)')
    args = parser.parse_args()

    if not args.code and not args.name:
        print("❌ --code 또는 --name 중 하나를 입력하세요.")
        parser.print_help()
        sys.exit(1)

    code = args.code
    if args.name:
        code = resolve_code(args.name)
        if not code:
            print(f"❌ '{args.name}'에 해당하는 종목을 찾을 수 없습니다.")
            print("💡 종목코드를 직접 입력하세요: --code 005930")
            sys.exit(1)

    cfg = load_config(args.config)
    token = get_token(cfg)
    data = get_quote(cfg, token, code)

    if not data:
        sys.exit(1)

    out = data.get('output', {})
    name = get_stock_name_by_code(code) or get_stock_name_from_api(cfg, token, code)
    cur_price = safe_int(out.get('stck_prpr'))
    change = safe_int(out.get('prdy_vrss'))
    change_rate = safe_float(out.get('prdy_ctrt'))
    volume = safe_int(out.get('acml_vol'))
    trade_amt = safe_int(out.get('acml_tr_pbmn'))
    high = safe_int(out.get('stck_hgpr'))
    low = safe_int(out.get('stck_lwpr'))
    open_p = safe_int(out.get('stck_oprc'))
    prev_close = safe_int(out.get('stck_sdpr'))
    market_cap = safe_int(out.get('hts_avls'))  # 시가총액(억원)

    sign = out.get('prdy_vrss_sign', '3')
    emoji = {'1': '🔺', '2': '🔼', '4': '🔻', '5': '🔽'}.get(sign, '➡️')

    print(f"{emoji} {name} ({code})")
    print(f"  현재가: {fmt_price(cur_price)} ({'+' if change >= 0 else ''}{fmt_num(change)}원, {fmt_rate(change_rate)})")
    print(f"  시가: {fmt_price(open_p)} | 고가: {fmt_price(high)} | 저가: {fmt_price(low)}")
    print(f"  전일종가: {fmt_price(prev_close)}")
    print(f"  거래량: {fmt_num(volume)}주 | 거래대금: {fmt_num(trade_amt // 1_000_000)}백만원")
    if market_cap:
        print(f"  시가총액: {fmt_num(market_cap)}억원")


if __name__ == '__main__':
    main()
