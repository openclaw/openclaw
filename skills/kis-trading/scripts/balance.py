#!/usr/bin/env python3
"""계좌 잔고 조회"""
from typing import Optional, Dict
import argparse
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from kis_common import load_config, get_token, api_get, fmt_price, fmt_rate, add_common_args, safe_int


def get_balance(cfg: dict, token: str) -> Optional[dict]:
    """계좌 잔고 조회"""
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
        "CTX_AREA_FK100": "",
        "CTX_AREA_NK100": "",
    }
    return api_get(cfg, token, '/uapi/domestic-stock/v1/trading/inquire-balance', 'TTTC8434R', params)


def main():
    parser = argparse.ArgumentParser(description='계좌 잔고 조회')
    add_common_args(parser)
    args = parser.parse_args()

    cfg = load_config(args.config)
    token = get_token(cfg)
    data = get_balance(cfg, token)

    if not data:
        sys.exit(1)

    # 계좌 요약 (output2)
    summary = data.get('output2', [{}])
    if isinstance(summary, list):
        summary = summary[0] if summary else {}

    print("💰 계좌 잔고")
    print(f"  예수금총액: {fmt_price(summary.get('dnca_tot_amt', 0))}")
    print(f"  익일정산금액: {fmt_price(summary.get('nxdy_excc_amt', 0))}")
    print(f"  가수도정산금액(매수가능): {fmt_price(summary.get('prvs_rcdl_excc_amt', 0))}")
    print(f"  총평가금액: {fmt_price(summary.get('tot_evlu_amt', 0))}")
    print(f"  평가손익합계: {fmt_price(summary.get('evlu_pfls_smtl_amt', 0))}")
    print(f"  매입금액합계: {fmt_price(summary.get('pchs_amt_smtl_amt', 0))}")
    print(f"  평가금액합계: {fmt_price(summary.get('evlu_amt_smtl_amt', 0))}")

    # 보유 종목 수
    holdings = data.get('output1', [])
    active = [h for h in holdings if int(str(h.get('hldg_qty', 0)).replace(',', '') or 0) > 0]
    print(f"  보유종목 수: {len(active)}개")


if __name__ == '__main__':
    main()
