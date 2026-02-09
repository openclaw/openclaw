#!/usr/bin/env python3
"""KIS 트레이딩 설정 확인 및 토큰 발급"""
import argparse
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from kis_common import load_config, get_token, add_common_args


def main():
    parser = argparse.ArgumentParser(description='KIS 트레이딩 설정 확인 및 인증 테스트')
    add_common_args(parser)
    parser.add_argument('--check', action='store_true', help='설정값 확인만 (API 호출 없음)')
    args = parser.parse_args()

    cfg = load_config(args.config)

    print("📋 설정 확인")
    print(f"  APP_KEY: {cfg['app_key'][:8]}...")
    print(f"  계좌번호: {cfg['account_no']}-{cfg['product_code']}")
    print(f"  BASE_URL: {cfg['base_url']}")

    is_demo = 'openapivts' in cfg['base_url']
    print(f"  모드: {'🧪 모의투자' if is_demo else '💰 실전투자'}")

    if args.check:
        print("\n✅ 설정값 정상")
        return

    print("\n🔑 토큰 발급 테스트...")
    token = get_token(cfg)
    print(f"✅ 토큰 발급 성공: {token[:20]}...")


if __name__ == '__main__':
    main()
