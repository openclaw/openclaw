from fastapi import FastAPI, Query
from typing import Optional
from appfolio_reports import get_unit_past_due, fetch_report

app = FastAPI()

@app.get("/unit_past_due/")
def unit_past_due(property_id: int = Query(...), unit_code: str = Query(...)):
    """Get the current balance (past_due) for a specific unit in a property."""
    past_due = get_unit_past_due(property_id, unit_code)
    if past_due is not None:
        return {"unit": unit_code, "property_id": property_id, "past_due": past_due}
    return {"error": f"Unit {unit_code} not found or error."}

@app.get("/fetch_report/")
def fetch_report_endpoint(
    report_name: str = Query(...),
    property_id: int = Query(...),
    columns: Optional[str] = Query(None, description="Comma-separated list of columns"),
):
    """Fetch any AppFolio report for a property and optional columns (comma-separated)."""
    columns_list = [c.strip() for c in columns.split(",")] if columns else None
    result = fetch_report(report_name, property_id, columns=columns_list)
    if result:
        return result
    return {"error": "Failed to fetch report."}

@app.get("/lookup_homeowner/")
def lookup_homeowner(phone: str = Query(...)):
    """Lookup homeowner by phone number and return unit and property_id."""
    # Use homeowner_directory with columns: ["phone", "unit", "property_id"]
    # This assumes phone numbers are stored in a normalized format
    # For demo, search all properties (could be optimized)
    # Replace 0 with a list of all property_ids if needed
    property_id = 0  # 0 or any valid property_id, or loop over all
    result = fetch_report(
        "homeowner_directory",
        property_id=property_id,
        columns=["phone", "unit", "property_id"]
    )
    if not result or "results" not in result:
        return {"error": "Failed to fetch homeowner_directory."}
    for entry in result["results"]:
        if entry.get("phone") == phone:
            return {
                "phone": phone,
                "unit": entry.get("unit"),
                "property_id": entry.get("property_id")
            }
    return {"error": f"Phone {phone} not found."}

# To run: uvicorn appfolio_api_server:app --reload
