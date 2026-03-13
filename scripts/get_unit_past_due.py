import requests
from requests.auth import HTTPBasicAuth
import sys
import os

# Usage: python get_unit_past_due.py <property_id> <unit_code>

API_URL = "https://precisionproperty.appfolio.com/api/v2/reports/dues_roll.json"


def _get_credentials():
    username = os.getenv("APPFOLIO_API_USERNAME")
    password = os.getenv("APPFOLIO_API_PASSWORD")
    if not username or not password:
        raise RuntimeError(
            "Missing AppFolio credentials. Set APPFOLIO_API_USERNAME and APPFOLIO_API_PASSWORD."
        )
    return username, password


def get_past_due(property_id, unit_code):
    username, password = _get_credentials()
    headers = {"Content-Type": "application/json"}
    data = {
        "properties": {"properties_ids": [property_id]},
        "columns": ["unit", "past_due"]
    }
    response = requests.post(
        API_URL,
        auth=HTTPBasicAuth(username, password),
        headers=headers,
        json=data
    )
    if not response.ok:
        print(f"API error: {response.status_code} {response.text}")
        return None
    results = response.json().get("results", [])
    for entry in results:
        if entry.get("unit") == unit_code:
            return entry.get("past_due")
    print(f"Unit {unit_code} not found in property {property_id}.")
    return None

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python get_unit_past_due.py <property_id> <unit_code>")
        sys.exit(1)
    property_id = int(sys.argv[1])
    unit_code = sys.argv[2]
    past_due = get_past_due(property_id, unit_code)
    if past_due is not None:
        print(f"Unit {unit_code} current balance (past_due): {past_due}")
