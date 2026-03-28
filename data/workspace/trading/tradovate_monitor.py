import requests
import json
import os

# Configuration for Tradovate API (Simulation/Demo)
TRADOVATE_URL = "https://demo.tradovateapi.com/v1"
USERNAME = os.environ.get("TRADOVATE_USERNAME", "")
PASSWORD = os.environ.get("TRADOVATE_PASSWORD", "")
APP_ID = "OpenClawTrader"
APP_VERSION = "1.0.0"

# Note: CID and SEC are often required for Tradovate API keys
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
    print(f"DEBUG: Requesting token from {TRADOVATE_URL}/auth/accesstokenrequest")
    print(f"DEBUG: Request Payload: {json.dumps({k:v for k,v in auth_data.items() if k != 'password'})}") # Don't log password
    
    try:
        response = requests.post(f"{TRADOVATE_URL}/auth/accesstokenrequest", json=auth_data)
        print(f"DEBUG: Response Status: {response.status_code}")
        print(f"DEBUG: Response Body: {response.text}")
        
        if response.status_code == 200:
            return response.json().get("accessToken")
        return None
    except Exception as e:
        print(f"DEBUG: Request Exception: {e}")
        return None

def get_account_list(token):
    headers = {"Authorization": f"Bearer {token}"}
    try:
        response = requests.get(f"{TRADOVATE_URL}/account/list", headers=headers)
        if response.status_code == 200:
            return response.json()
        print(f"DEBUG: Account List Failed (Status {response.status_code}): {response.text}")
        return None
    except Exception as e:
        print(f"DEBUG: Account List Exception: {e}")
        return None

if __name__ == "__main__":
    print("--- Tradovate Credential Check ---")
    token = get_access_token()
    if token:
        print("SUCCESS: Access Token retrieved.")
        accounts = get_account_list(token)
        if accounts:
            print(f"SUCCESS: Found {len(accounts)} accounts.")
            print(json.dumps(accounts, indent=2))
        else:
            print("FAILURE: No accounts found or list empty.")
    else:
        print("FAILURE: Could not get access token.")
