# File: /home/user/openclaw/scripts/install_yield_stack.sh

#!/bin/bash

echo "Starting autonomous installation of high-yield OpenClaw skills..."

# Install Playwright Scraper (Requires browser binaries)
clawhub install playwright-scraper-skill
npx playwright install chromium

# Install Market Research and Data Skills
clawhub install x-research
clawhub install multi-search-engine

# Install Communication and Content Skills
clawhub install agentmail
clawhub install seo-content-writer

echo "Installation complete. Verifying skill registry..."
clawhub list --installed

echo "All skills are now active and ready for Claw Earn tasks."
