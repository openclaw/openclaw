import requests
import json
import os

# Configuration for Tradovate API (Simulation/Demo)
TRADOVATE_URL = "https://demo.tradovateapi.com/v1"
USERNAME = "tahoeryry"
PASSWORD = "@Donnasue1944."
APP_ID = "OpenClawTrader"
APP_VERSION = "1.0.0"
CID = os.environ.get("TRADOVATE_CID")
SEC = os.environ.get("TRADOVATE_SEC")

def get_access_token():
    auth_data = {
        "name": USERNAME,
        "password": PASSWORD,
        "appId": APP_ID,
        "appVersion": APP_VERSION,
        "cid": CID,
        "sec": SEC
    }
    response = requests.post(f"{TRADOVATE_URL}/auth/accesstokenrequest", json=auth_data)
    if response.status_code == 200:
        return response.json().get("accessToken")
    else:
        print(f"Auth failed: {response.text}")
        return None

def get_account_list(token):
    headers = {"Authorization": f"Bearer {token}"}
    response = requests.get(f"{TRADOVATE_URL}/account/list", headers=headers)
    if response.status_code == 200:
        return response.json()
    return None

if __name__ == "__main__":
    token = get_access_token()
    if token:
        accounts = get_account_list(token)
        print(json.dumps(accounts, indent=2))
