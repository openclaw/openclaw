# https://github.com/ram133/openclaw/outreach.py
# Path: ~/Desktop/openclaw/outreach.py
# Action: Autonomous B2B Outreach Drafting

def draft_outreach():
    try:
        with open("prospects.txt", "r") as f:
            leads = f.readlines()
        
        drafts = []
        for lead in leads:
            if "TITLE: Decision Maker" in lead:
                parts = lead.strip().split(" | ")
                email = parts[1]
                
                message = f"""
                To: {email}
                Subject: Strategic Lead Acquisition for your sector
                
                I've identified several high-intent opportunities in the Guam market 
                that align with your recent activity. You can review our performance 
                metrics and corporate portfolio here: https://www.ray.services/market.php
                
                Regards,
                RayNV Autonomous Systems
                """
                drafts.append(message + "\n" + "="*30 + "\n")
        
        with open("outbox.txt", "w") as f:
            f.writelines(drafts)
            
        print("Action: Outreach Drafting. Result: outbox.txt updated with B2B drafts.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    draft_outreach()
