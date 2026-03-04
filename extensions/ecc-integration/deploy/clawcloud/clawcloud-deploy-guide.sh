#!/bin/bash

echo "🔍 ClawCloud Deployment Guide"
echo "=========================="

echo "📋 Since you can't find Git Repository settings, here are alternatives:"
echo ""

echo "🎯 Option 1: Redeploy with Custom Git URL"
echo "----------------------------------------"
echo "1. Go to ClawCloud dashboard"
echo "2. Delete current app (save environment variables first)"
echo "3. Create new app using template"
echo "4. In 'Repository URL' field, enter your fork URL:"
echo "   https://github.com/YOUR_USERNAME/openclaw.git"
echo "5. Deploy - it will use your ECC code"
echo ""

echo "🎯 Option 2: Use ClawCloud Template with Your Code"
echo "---------------------------------------------"
echo "1. Go to: https://run.claw.cloud"
echo "2. Search for 'OpenClaw ECC' template"
echo "3. Click 'Deploy'"
echo "4. In advanced settings, set custom repo URL"
echo ""

echo "🎯 Option 3: Manual Deployment via API"
echo "-----------------------------------"
echo "Use ClawCloud API to update deployment:"
echo ""

APP_URL="http://openclaw-hlpomtim.ap-southeast-1.clawcloud.run"
echo "Current app: $APP_URL"
echo ""

echo "📱 Quick test while you figure this out:"
echo "Send these commands to @picklerick777bot:"
echo "  /onboard    - Start onboarding"
echo "  /status     - Check system"
echo "  /models     - See models"
echo ""

echo "🔧 Your ECC code is ready - just need to deploy it!"
