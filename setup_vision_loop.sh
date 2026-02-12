#!/bin/bash
# O.R.I.O.N. Vision Loop Setup Script
# ====================================
# Installs all dependencies for visual desktop automation

echo "=========================================="
echo "O.R.I.O.N. Vision Loop Setup"
echo "=========================================="
echo ""

# Check if Python 3 is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.8 or higher."
    exit 1
fi

echo "✅ Python 3 found: $(python3 --version)"
echo ""

# Check if pip is available
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is not installed. Please install pip."
    exit 1
fi

echo "✅ pip3 found"
echo ""

# Install Python dependencies
echo "📦 Installing Python dependencies..."
echo ""

pip3 install -r requirements.txt

echo ""
echo "=========================================="
echo "Checking Vision Loop Dependencies"
echo "=========================================="
echo ""

# Test imports
python3 << 'EOF'
import sys

deps = {
    "mss": "Screenshot capture",
    "PIL": "Image processing",
    "pyautogui": "GUI automation",
    "google.genai": "Gemini Vision API"
}

all_ok = True
for module, description in deps.items():
    try:
        __import__(module.split('.')[0])
        print(f"✅ {module:20s} - {description}")
    except ImportError:
        print(f"❌ {module:20s} - {description} (MISSING)")
        all_ok = False

print()
if all_ok:
    print("✅ All dependencies installed successfully!")
else:
    print("⚠️ Some dependencies are missing. Please check the errors above.")
    sys.exit(1)
EOF

if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Dependency check failed. Please install missing packages:"
    echo "   pip3 install mss pillow pyautogui google-genai"
    exit 1
fi

echo ""
echo "=========================================="
echo "Checking Environment Variables"
echo "=========================================="
echo ""

# Check for GEMINI_API_KEY
if [ -z "$GEMINI_API_KEY" ]; then
    echo "⚠️ GEMINI_API_KEY not set!"
    echo ""
    echo "To enable Vision Loop, you need a Gemini API key:"
    echo "  1. Get your API key from: https://aistudio.google.com/apikey"
    echo "  2. Export it: export GEMINI_API_KEY='your-key-here'"
    echo "  3. Or add to ~/.bashrc: echo 'export GEMINI_API_KEY=\"your-key\"' >> ~/.bashrc"
    echo ""
else
    echo "✅ GEMINI_API_KEY is set"
    echo "   Key preview: ${GEMINI_API_KEY:0:10}..."
fi

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "🚀 Ready to test the Vision Loop!"
echo ""
echo "Run the demo:"
echo "  python3 demo_vision_loop.py"
echo ""
echo "Or test the executive module directly:"
echo "  python3 modules/executive.py"
echo ""
echo "Quick start example:"
echo "  python3 << 'EOF'"
echo "  from modules.executive import OrionExecutive"
echo "  exec = OrionExecutive(trust_mode=False)"
echo "  result = exec.vision_loop('click the browser icon')"
echo "  print(result)"
echo "  EOF"
echo ""
