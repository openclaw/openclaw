#!/bin/bash

# Office Skill - Test Workflow
# This script demonstrates the basic workflow of the office skill

set -e

echo "🏢 Office Skill - Test Workflow"
echo "================================"
echo ""

cd ~/Documents/openclaw/skills/office

echo "1️⃣  Show help"
node office-cli.js
echo ""

echo "2️⃣  Show dashboard"
node office-cli.js dashboard
echo ""

echo "3️⃣  Create a test team"
node office-cli.js team create test-team --agents agent1,agent2,agent3 --orchestrator main
echo ""

echo "4️⃣  List teams"
node office-cli.js team list
echo ""

echo "5️⃣  Show team info"
node office-cli.js team info test-team
echo ""

echo "6️⃣  Send message to team"
node office-cli.js send test-team "Hello team! Let's work together."
echo ""

echo "7️⃣  Spawn agent task"
node office-cli.js spawn agent1 "Complete the assigned task" --model default --thread
echo ""

echo "8️⃣  List sessions"
node office-cli.js sessions list
echo ""

echo "9️⃣  Stop the test team"
node office-cli.js team kill test-team
echo ""

echo "✅ Test workflow complete!"
echo ""
echo "📁 Team data stored at: ~/.openclaw/agents/main/office/teams.json"
echo "📖 For more info, see: README.md, SKILL.md, WORKSPACE-INTEGRATION.md"
