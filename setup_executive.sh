#!/bin/bash
# O.R.I.O.N. EXECUTIVE MODULE INSTALLER
# Automatically detects OS and installs platform-specific dependencies

set -e  # Exit on error

echo "============================================================"
echo "O.R.I.O.N. EXECUTIVE MODULE - DEPENDENCY INSTALLER"
echo "============================================================"

# Detect OS
OS="$(uname -s)"
echo "Detected OS: $OS"

# Install platform-specific dependencies
case "$OS" in
    Darwin*)
        echo "📦 Installing macOS dependencies..."
        pip install pyobjc-core pyobjc || echo "⚠️  pyobjc installation failed (may need sudo)"
        ;;
    Linux*)
        echo "📦 Installing Linux dependencies..."
        sudo apt-get update
        sudo apt-get install -y python3-tk python3-dev python3-xlib || echo "⚠️  apt-get failed"
        pip install python3-xlib
        ;;
    MINGW*|MSYS*|CYGWIN*)
        echo "📦 Installing Windows dependencies..."
        pip install pywin32
        ;;
    *)
        echo "❌ Unknown OS: $OS"
        exit 1
        ;;
esac

# Install universal dependencies
echo ""
echo "📦 Installing universal dependencies..."
pip install pyautogui flask requests playwright

# Install Playwright browsers
echo ""
echo "📦 Installing Playwright browsers..."
playwright install chromium

echo ""
echo "============================================================"
echo "✅ O.R.I.O.N. EXECUTIVE MODULE INSTALLED SUCCESSFULLY"
echo "============================================================"
echo ""
echo "Test with: python modules/executive.py"
