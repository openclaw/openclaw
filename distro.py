# https://github.com/ram133/openclaw/distro.py
# Path: ~/Desktop/openclaw/distro.py
# Action: Packaging Ranked Leads for B2B Sale

def package_leads():
    try:
        with open("ranked_leads.txt", "r") as f:
            leads = f.readlines()
        
        # Select top 10 highest-scoring leads for the "Premium Batch"
        premium_batch = leads[:10]
        
        with open("premium_leads.txt", "w") as f:
            f.writelines(premium_batch)
            
        print("Action: Lead Packaging. Result: premium_leads.txt ready for sale.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    package_leads()
