# https://github.com/ram133/openclaw/invoice.py
# Path: ~/Desktop/openclaw/invoice.py
# Action: Autonomous B2B Billing for Lead Generation

import datetime

def generate_invoice(company_name, lead_count, rate_per_lead=50):
    total = lead_count * rate_per_lead
    date_str = datetime.datetime.now().strftime("%Y-%m-%d")
    
    invoice_content = f"""
    RAYNV ENGINE - B2B INVOICE
    Date: {date_str}
    Client: {company_name}
    ---------------------------
    Description: High-Intent Leads (Guam Sector)
    Quantity: {lead_count}
    Rate: ${rate_per_lead}.00
    TOTAL DUE: ${total}.00
    ---------------------------
    Pay via: ray.services/pay
    """
    
    filename = f"invoice_{company_name.lower()}_{date_str}.txt"
    with open(filename, "w") as f:
        f.write(invoice_content)
    print(f"Action: Invoice Generation. Result: Created {filename}")

if __name__ == "__main__":
    # Placeholder for the 9:00 AM autonomous run
    # It will pull from prospects.txt and generate billing for active clients
    generate_invoice("Sample_HVAC_Corp", 5)
