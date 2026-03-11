# https://github.com/ram133/openclaw/intel.py
# Path: ~/Desktop/openclaw/intel.py
# Action: Autonomous Keyword Theft & SEO Optimization

import requests
from bs4 import BeautifulSoup

TARGETS = ["guamrealestate.com", "guamhomehelp.com", "hvacguam.com"]

def harvest_keywords():
    stolen_keywords = []
    for site in TARGETS:
        try:
            r = requests.get(f"https://{site}", timeout=10)
            soup = BeautifulSoup(r.text, 'html.parser')
            meta = soup.find("meta", {"name": "keywords"})
            if meta:
                stolen_keywords.extend(meta['content'].split(','))
        except:
            continue
    
    # Save to root for SEO injection
    with open("keywords.txt", "w") as f:
        f.write(", ".join(set(stolen_keywords)))
    print("Action: Intel Harvest. Result: Keywords cached for SEO update.")

if __name__ == "__main__":
    harvest_keywords()
