#!/usr/bin/env python3
"""보유 종목 + 수익률 조회"""
from typing import Optional, Dict
import argparse
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from kis_common import load_config, get_token, api_get, fmt_price, fmt_rate, fmt_num, add_common_args, safe_int, safe_float


def get_holdings(cfg: dict, token: str) -> list:
    """보유 종목 조회 (페이지네이션 포함)"""
    all_holdings = []
    ctx_fk = ""
    ctx_nk = ""

    while True:
        params = {
            "CANO": cfg['account_no'],
            "ACNT_PRDT_CD": cfg['product_code'],
            "AFHR_FLPR_YN": "N",
            "OFL_YN": "",
            "INQR_DVSN": "00",
            "UNPR_DVSN": "01",
            "FUND_STTL_ICLD_YN": "N",
            "FNCG_AMT_AUTO_RDPT_YN": "N",
            "PRCS_DVSN": "00",
            "CTX_AREA_FK100": ctx_fk,
            "CTX_AREA_NK100": ctx_nk,
        }
        data = api_get(cfg, token, '/uapi/domestic-stock/v1/trading/inquire-balance', 'TTTC8434R', params)
        if not data:
            break

        items = data.get('output1', [])
        all_holdings.extend(items)

        # 연속조회 확인 (F/M = 다음 페이지 있음)
        tr_cont = data.get('_tr_cont', '')
        if tr_cont in ('F', 'M') and items:
            ctx_fk = data.get('ctx_area_fk100', data.get('CTX_AREA_FK100', ''))
            ctx_nk = data.get('ctx_area_nk100', data.get('CTX_AREA_NK100', ''))
            if not ctx_fk and not ctx_nk:
                break
        else:
            break

    return all_holdings, data


def main():
    parser = argparse.ArgumentParser(description='보유 종목 및 수익률 조회')
    add_common_args(parser)
    args = parser.parse_args()

    cfg = load_config(args.config)
    token = get_token(cfg)
    holdings_list, last_data = get_holdings(cfg, token)

    if last_data is None:
        sys.exit(1)

    active = [h for h in holdings_list if safe_int(h.get('hldg_qty')) > 0]

    if not active:
        print("📊 보유 종목 없음")
        return

    print(f"📊 보유 종목 ({len(active)}개)")
    print()

    total_purchase = 0
    total_eval = 0
    total_pl = 0

    for h in active:
        name = h.get('prdt_name', '???')
        code = h.get('pdno', '')
        qty = safe_int(h.get('hldg_qty'))
        avg_price = safe_float(h.get('pchs_avg_pric'))
        cur_price = safe_int(h.get('prpr'))
        eval_amt = safe_int(h.get('evlu_amt'))
        pl_amt = safe_int(h.get('evlu_pfls_amt'))
        pl_rate = safe_float(h.get('evlu_pfls_rt'))

        total_purchase += safe_int(h.get('pchs_amt'))
        total_eval += eval_amt
        total_pl += pl_amt

        emoji = '🔴' if pl_amt < 0 else '🟢' if pl_amt > 0 else '⚪'
        print(f"{emoji} {name} ({code})")
        print(f"   {fmt_num(qty)}주 | 평균 {fmt_price(int(avg_price))} → 현재 {fmt_price(cur_price)}")
        print(f"   평가 {fmt_price(eval_amt)} | 손익 {fmt_price(pl_amt)} ({fmt_rate(pl_rate)})")
        print()

    print("─" * 40)
    total_rate = (total_pl / total_purchase * 100) if total_purchase > 0 else 0
    emoji = '🔴' if total_pl < 0 else '🟢' if total_pl > 0 else '⚪'
    print(f"{emoji} 합계: 매입 {fmt_price(total_purchase)} | 평가 {fmt_price(total_eval)} | 손익 {fmt_price(total_pl)} ({fmt_rate(total_rate)})")


if __name__ == '__main__':
    main()
