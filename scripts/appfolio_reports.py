import requests
from requests.auth import HTTPBasicAuth
import os

API_BASE = "https://precisionproperty.appfolio.com/api/v2/reports/"


def _get_credentials():
    username = os.getenv("APPFOLIO_API_USERNAME")
    password = os.getenv("APPFOLIO_API_PASSWORD")
    if not username or not password:
        raise RuntimeError(
            "Missing AppFolio credentials. Set APPFOLIO_API_USERNAME and APPFOLIO_API_PASSWORD."
        )
    return username, password

def fetch_report(report_name, property_id, columns=None, extra_payload=None):
    """
    Fetches a report from AppFolio for a given property_id and columns.
    Optionally accepts extra_payload for additional POST fields.
    Returns the JSON response or None on error.
    """
    url = f"{API_BASE}{report_name}.json"
    headers = {"Content-Type": "application/json"}
    data = {
        "properties": {"properties_ids": [property_id]},
    }
    if columns:
        data["columns"] = columns
    if extra_payload:
        data.update(extra_payload)
    try:
        username, password = _get_credentials()
        response = requests.post(
            url,
            auth=HTTPBasicAuth(username, password),
            headers=headers,
            json=data,
            timeout=30
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"Error fetching {report_name}: {e}")
        return None

def get_unit_past_due(property_id, unit_code):
    """
    Returns the past_due balance for a specific unit in a property.
    """
    result = fetch_report("dues_roll", property_id, columns=["unit", "past_due"])
    if not result or "results" not in result:
        return None
    for entry in result["results"]:
        if entry.get("unit") == unit_code:
            return entry.get("past_due")
    return None

# Example usage (can be removed or adapted for integration):
if __name__ == "__main__":
    # Example: get past_due for unit GO10 in property 50
    property_id = 50
    unit_code = "GO10"
    past_due = get_unit_past_due(property_id, unit_code)
    if past_due is not None:
        print(f"Unit {unit_code} current balance (past_due): {past_due}")
    else:
        print(f"Unit {unit_code} not found or error.")
