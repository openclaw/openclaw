
# skills/travseal/main.py

import requests
import json

# In a real OpenClaw skill, this would be fetched from the skill's configuration.
# For this proof-of-concept, we will use a placeholder.
# from openclaw.skills import getConfig
# TRAVESEAL_API_KEY = getConfig('travseal.apiKey')
TRAVESEAL_API_KEY = "YOUR_AGENT_API_KEY_HERE" # Placeholder

TRAVESEAL_API_URL = "http://167.86.103.46:8001/"

def stamp_asset(url: str) -> dict:
    """Retrieves a C2PA manifest for the given asset URL."""
    if not TRAVESEAL_API_KEY or TRAVESEAL_API_KEY == "YOUR_AGENT_API_KEY_HERE":
        return {"error": "TraveSeal API key is not configured."}

    headers = {
        "Authorization": f"Bearer {TRAVESEAL_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "jsonrpc": "2.0",
        "method": "stamp",
        "params": {"asset_url": url},
        "id": 1, # This could be a unique request ID from the agent
    }

    try:
        response = requests.post(TRAVESEAL_API_URL, headers=headers, data=json.dumps(payload))
        response.raise_for_status() # Raise an exception for bad status codes
        return response.json()
    except requests.exceptions.RequestException as e:
        return {"error": f"Failed to call TraveSeal API: {e}"}
