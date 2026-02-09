#!/usr/bin/env python3
"""매매 내역 조회"""
from typing import Optional, Dict
import argparse
import sys
import os
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from kis_common import load_config, get_token, api_get, fmt_price, fmt_num, add_common_args, safe_int


def get_daily_orders(cfg: dict, token: str, start: str, end: str) -> list:
    """일별 주문체결 조회 (페이지네이션 포함)"""
    all_orders = []
    ctx_fk = ""
    ctx_nk = ""

    while True:
        params = {
            "CANO": cfg['account_no'],
            "ACNT_PRDT_CD": cfg['product_code'],
            "INQR_STRT_DT": start,
            "INQR_END_DT": end,
            "SLL_BUY_DVSN_CD": "00",
            "INQR_DVSN": "01",
            "PDNO": "",
            "CCLD_DVSN": "00",
            "ORD_GNO_BRNO": "",
            "ODNO": "",
            "INQR_DVSN_3": "00",
            "INQR_DVSN_1": "",
            "CTX_AREA_FK100": ctx_fk,
            "CTX_AREA_NK100": ctx_nk,
        }
        data = api_get(cfg, token, '/uapi/domestic-stock/v1/trading/inquire-daily-ccld', 'TTTC0081R', params)
        if not data:
            break

        items = data.get('output1', [])
        all_orders.extend(items)

        tr_cont = data.get('_tr_cont', '')
        if tr_cont in ('F', 'M') and items:
            ctx_fk = data.get('ctx_area_fk100', data.get('CTX_AREA_FK100', ''))
            ctx_nk = data.get('ctx_area_nk100', data.get('CTX_AREA_NK100', ''))
            if not ctx_fk and not ctx_nk:
                break
        else:
            break

    return all_orders


def main():
    parser = argparse.ArgumentParser(description='매매 내역 조회')
    add_common_args(parser)
    today = datetime.today().strftime('%Y%m%d')
    parser.add_argument('--start', default=today, help='조회 시작일 (YYYYMMDD, 기본: 오늘)')
    parser.add_argument('--end', default=today, help='조회 종료일 (YYYYMMDD, 기본: 오늘)')
    args = parser.parse_args()

    cfg = load_config(args.config)
    token = get_token(cfg)
    orders = get_daily_orders(cfg, token, args.start, args.end)

    if not orders:
        print(f"📋 매매 내역 없음 ({args.start} ~ {args.end})")
        return

    print(f"📋 매매 내역 ({args.start} ~ {args.end}, {len(orders)}건)")
    print()

    for o in orders:
        name = o.get('prdt_name', o.get('pdno', '???'))
        side = o.get('sll_buy_dvsn_cd_name', o.get('sll_buy_dvsn_cd', ''))
        ord_qty = safe_int(o.get('ord_qty'))
        ccld_qty = safe_int(o.get('tot_ccld_qty'))
        ord_price = safe_int(o.get('ord_unpr'))
        ccld_price = safe_int(o.get('avg_prvs'))
        order_time = o.get('ord_tmd', '')
        status = '체결' if ccld_qty > 0 else '미체결'

        emoji = '🟢' if '매수' in side else '🔴' if '매도' in side else '⚪'
        time_str = f"{order_time[:2]}:{order_time[2:4]}:{order_time[4:6]}" if len(order_time) >= 6 else order_time

        print(f"{emoji} {name} | {side} | {status}")
        print(f"   주문 {fmt_num(ord_qty)}주 @ {fmt_price(ord_price)} | 체결 {fmt_num(ccld_qty)}주 @ {fmt_price(ccld_price)} | {time_str}")
        print()


if __name__ == '__main__':
    main()
