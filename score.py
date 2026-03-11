# https://github.com/ram133/openclaw/score.py
# Path: ~/Desktop/openclaw/score.py
# Action: Autonomous Lead Scoring & Prioritization

def score_leads():
    try:
        with open("prospects.txt", "r") as f:
            leads = f.readlines()
        
        scored_leads = []
        for lead in leads:
            score = 50  # Base score
            parts = lead.strip().split(" | ")
            if len(parts) < 3: continue
            
            email = parts[1].lower()
            industry = parts[2]

            # High-Value Industry Bonus
            if "HVAC" in industry or "Real Estate" in industry:
                score += 20
            
            # Corporate Domain Bonus (Non-generic)
            if not any(x in email for x in ["@gmail", "@yahoo", "@icloud", "@outlook"]):
                score += 30

            scored_leads.append(f"{score} | {lead.strip()}")
        
        # Sort by highest score
        scored_leads.sort(reverse=True, key=lambda x: int(x.split(" | ")[0]))
        
        with open("ranked_leads.txt", "w") as f:
            f.writelines([line + "\n" for line in scored_leads])
            
        print("Action: Lead Scoring. Result: ranked_leads.txt updated.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    score_leads()
