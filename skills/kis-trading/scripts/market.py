#!/usr/bin/env python3
"""시장 개황 (지수, 거래량 상위 등)"""
from typing import Optional, Dict
import argparse
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from kis_common import load_config, get_token, api_get, fmt_price, fmt_rate, fmt_num, add_common_args, safe_int, safe_float


def get_index(cfg: dict, token: str, index_code: str) -> Optional[dict]:
    """업종 지수 조회"""
    params = {
        "FID_COND_MRKT_DIV_CODE": "U",
        "FID_INPUT_ISCD": index_code,
    }
    return api_get(cfg, token, '/uapi/domestic-stock/v1/quotations/inquire-index-price', 'FHPUP02100000', params)


def get_volume_rank(cfg: dict, token: str, market: str = "0000") -> Optional[dict]:
    """거래량 순위 조회"""
    params = {
        "FID_COND_MRKT_DIV_CODE": "J",
        "FID_COND_SCR_DIV_CODE": "20171",
        "FID_INPUT_ISCD": market,  # 0000:전체, 0001:거래소, 1001:코스닥
        "FID_DIV_CLS_CODE": "0",
        "FID_BLNG_CLS_CODE": "0",  # 0:평균거래량
        "FID_TRGT_CLS_CODE": "111111111",
        "FID_TRGT_EXLS_CLS_CODE": "0000000000",
        "FID_INPUT_PRICE_1": "",
        "FID_INPUT_PRICE_2": "",
        "FID_VOL_CNT": "",
        "FID_INPUT_DATE_1": "",
    }
    return api_get(cfg, token, '/uapi/domestic-stock/v1/quotations/volume-rank', 'FHPST01710000', params)


def show_index(cfg: dict, token: str):
    """코스피/코스닥 지수 출력"""
    for name, code in [('코스피', '0001'), ('코스닥', '1001')]:
        data = get_index(cfg, token, code)
        if not data:
            continue
        out = data.get('output', {})
        if isinstance(out, list):
            out = out[0] if out else {}

        idx_val = out.get('bstp_nmix_prpr', '0')
        change = out.get('bstp_nmix_prdy_vrss', '0')
        rate = out.get('bstp_nmix_prdy_ctrt', '0')
        vol = out.get('acml_vol', '0')
        sign = out.get('prdy_vrss_sign', '3')

        emoji = {'1': '🔺', '2': '🔼', '4': '🔻', '5': '🔽'}.get(sign, '➡️')
        print(f"{emoji} {name}: {idx_val} ({'+' if safe_float(change) >= 0 else ''}{change}, {fmt_rate(rate)})")
        print(f"   거래량: {fmt_num(vol)}주")


def show_volume_rank(cfg: dict, token: str, limit: int = 15):
    """거래량 상위 종목 출력"""
    data = get_volume_rank(cfg, token)
    if not data:
        return

    items = data.get('output', [])
    if not items:
        print("📊 거래량 데이터 없음")
        return

    print(f"📊 거래량 상위 종목 (상위 {min(limit, len(items))}개)")
    print()

    for i, item in enumerate(items[:limit], 1):
        name = item.get('hts_kor_isnm', '???')
        code = item.get('mksc_shrn_iscd', '')
        price = safe_int(item.get('stck_prpr'))
        change_rate = safe_float(item.get('prdy_ctrt'))
        volume = safe_int(item.get('acml_vol'))
        sign = item.get('prdy_vrss_sign', '3')

        emoji = {'1': '🔺', '2': '🔼', '4': '🔻', '5': '🔽'}.get(sign, '➡️')
        print(f"  {i:2d}. {emoji} {name} ({code}) {fmt_price(price)} ({fmt_rate(change_rate)}) 거래량 {fmt_num(volume)}")


def main():
    parser = argparse.ArgumentParser(description='시장 개황 조회')
    add_common_args(parser)
    parser.add_argument('--action', '-a', default='all',
                        choices=['all', 'index', 'volume-rank'],
                        help='조회 항목 (기본: all)')
    parser.add_argument('--limit', type=int, default=15, help='거래량 순위 표시 개수 (기본: 15)')
    args = parser.parse_args()

    cfg = load_config(args.config)
    token = get_token(cfg)

    if args.action in ('all', 'index'):
        print("📈 시장 지수")
        show_index(cfg, token)
        print()

    if args.action in ('all', 'volume-rank'):
        show_volume_rank(cfg, token, args.limit)


if __name__ == '__main__':
    main()
