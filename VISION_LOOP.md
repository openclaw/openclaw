# O.R.I.O.N. Vision Loop System

## Overview

The **Vision Loop** upgrades O.R.I.O.N. from browser-only automation to **full desktop visual automation**. Using computer vision (Gemini 2.0 Flash with vision), O.R.I.O.N. can now:

- 👀 **See your screen** - Capture and analyze any application
- 🎯 **Find UI elements** - Locate buttons, text fields, icons using AI vision
- 👆 **Interact with anything** - Click, type, and control any app (not just browsers)
- 🔗 **Bridge applications** - Read from Excel, type into YouTube, etc.
- ✓ **Verify actions** - Take before/after screenshots to confirm

## The Vision Loop Cycle

```
┌─────────────┐
│  1. SNAPSHOT │  📸 Capture screenshot of current screen
└──────┬──────┘
       │
┌──────▼──────┐
│  2. ANALYZE  │  🧠 Use Gemini Vision to find UI elements
└──────┬──────┘       Returns (x, y) coordinates
       │
┌──────▼──────┐
│  3. ACTION   │  👆 Click/type at the identified coordinates
└──────┬──────┘
       │
┌──────▼──────┐
│  4. VERIFY   │  ✓ Take another screenshot to confirm success
└─────────────┘
```

## Installation

### 1. Install Dependencies

```bash
# Quick setup (recommended)
./setup_vision_loop.sh

# Or manually
pip3 install mss pillow pyautogui google-genai
```

### 2. Set up Gemini API Key

Get your free API key from: https://aistudio.google.com/apikey

```bash
# Export for current session
export GEMINI_API_KEY='your-key-here'

# Or add to your shell profile
echo 'export GEMINI_API_KEY="your-key"' >> ~/.bashrc
source ~/.bashrc
```

### 3. Verify Installation

```bash
python3 modules/executive.py
```

## Usage

### Python API

```python
from modules.executive import OrionExecutive

# Initialize the executive
executive = OrionExecutive(trust_mode=False)  # Requires manual confirmation

# Method 1: Full Vision Loop (Recommended)
# Automatically: captures screen → analyzes → clicks → verifies
result = executive.vision_loop(
    task="click the browser icon",
    max_attempts=3,
    verify=True
)

if result["success"]:
    print(f"✅ Clicked successfully!")
    print(f"Coordinates: {result['attempts'][-1]['coordinates']}")
else:
    print(f"❌ Failed: {result['error']}")


# Method 2: Manual Control (Advanced)
# Step 1: Capture screenshot
screenshot = executive.capture_screenshot()

# Step 2: Analyze for specific element
analysis = executive.analyze_screen(
    query="find the search button and return its coordinates",
    screenshot_data=screenshot
)

# Step 3: Click at coordinates
if analysis["coordinates"]:
    coords = analysis["coordinates"][0]
    executive.gui_control('click', x=coords['x'], y=coords['y'])


# Method 3: Direct GUI control (if you know coordinates)
executive.gui_control('move', x=100, y=200)
executive.gui_control('click', x=100, y=200)
executive.gui_control('type', text='Hello World')
executive.gui_control('hotkey', text='ctrl+c')
```

### Command-Line Usage

```bash
# Run the interactive demo
python3 demo_vision_loop.py

# Quick test
python3 << 'EOF'
from modules.executive import OrionExecutive
exec = OrionExecutive(trust_mode=True)
exec.vision_loop("click the terminal icon")
EOF
```

## Use Cases

### 1. Simple Click Automation

```python
# Find and click any UI element
executive.vision_loop("click the Start button")
executive.vision_loop("click the search bar")
executive.vision_loop("click the submit button")
```

### 2. Application Bridging

```python
# Example: Read from Slack, send to Discord
executive = OrionExecutive(trust_mode=False)

# Step 1: Capture Slack message
screenshot = executive.capture_screenshot()
analysis = executive.analyze_screen(
    "read the last message in the Slack window",
    screenshot
)

# Step 2: Switch to Discord
executive.vision_loop("click the Discord icon")

# Step 3: Type the message
executive.vision_loop("click the message input field")
executive.gui_control("type", text=analysis["analysis"])
executive.gui_control("hotkey", text="enter")
```

### 3. Cross-App Data Transfer

```python
# Excel → YouTube search
executive = OrionExecutive(trust_mode=False)

# Read from Excel
screenshot = executive.capture_screenshot()
analysis = executive.analyze_screen(
    "read the text in cell A1 of the Excel spreadsheet",
    screenshot
)

# Switch to browser
executive.vision_loop("click the browser icon")

# Search on YouTube
executive.vision_loop("click the YouTube search bar")
executive.gui_control("type", text=analysis["analysis"])
executive.gui_control("hotkey", text="enter")
```

### 4. UI Testing & Verification

```python
# Take before/after screenshots for automated testing
result = executive.vision_loop(
    task="click the login button",
    verify=True
)

print(f"Before: {result['attempts'][0]['screenshot_before']}")
print(f"After: {result['attempts'][0]['screenshot_after']}")
```

## API Reference

### OrionExecutive

Main class for desktop automation.

#### Methods

##### `__init__(trust_mode: bool = False)`

Initialize the executive module.

- `trust_mode`: If `False`, prompts for confirmation before actions (safer)

##### `capture_screenshot(save_path: Optional[str] = None) -> Dict`

Capture a screenshot of the entire screen.

**Returns:**

```python
{
    "success": True,
    "path": "screenshots/screenshot_20260211_120000.png",
    "size": (1920, 1080),
    "image_base64": "iVBORw0KG...",
    "image": <PIL.Image>
}
```

##### `analyze_screen(query: str, screenshot_data: Optional[Dict] = None) -> Dict`

Analyze a screenshot using Gemini Vision.

**Parameters:**

- `query`: What to find (e.g., "find the OK button")
- `screenshot_data`: Optional pre-captured screenshot

**Returns:**

```python
{
    "success": True,
    "analysis": "I found the OK button in the center...",
    "coordinates": [
        {"x": 640, "y": 480}
    ],
    "screenshot": "screenshots/..."
}
```

##### `vision_loop(task: str, max_attempts: int = 3, verify: bool = True) -> Dict`

Execute the complete Vision Loop cycle.

**Parameters:**

- `task`: Natural language task (e.g., "click the browser icon")
- `max_attempts`: Maximum retry attempts
- `verify`: Whether to take verification screenshot

**Returns:**

```python
{
    "task": "click the browser icon",
    "success": True,
    "attempts": [
        {
            "attempt": 1,
            "screenshot_before": "screenshots/...",
            "analysis": "Found browser icon at...",
            "coordinates": {"x": 100, "y": 200},
            "action": {"success": True, ...},
            "screenshot_after": "screenshots/..."
        }
    ]
}
```

##### `gui_control(action: str, x: int, y: int, text: str) -> Dict`

Low-level GUI control.

**Actions:**

- `'move'` - Move mouse to (x, y)
- `'click'` - Click at (x, y) or current position
- `'type'` - Type text
- `'hotkey'` - Press key combination (e.g., "ctrl+c")

##### `get_stats() -> Dict`

Get executive module statistics.

## Security Features

### 1. Confirmation Prompts

When `trust_mode=False`, all physical actions require user confirmation:

```
==============================================================
⚠️  O.R.I.O.N. IS REQUESTING PHYSICAL CONTROL
==============================================================
Action: GUI click
Details: x=640, y=480
==============================================================
Allow this action? [Y/N]:
```

### 2. Action Logging

All actions are logged to `logs/executive.log`:

```json
{
  "timestamp": "2026-02-11T12:00:00",
  "session": "20260211_120000",
  "action": "gui_click",
  "details": { "x": 640, "y": 480 },
  "action_number": 1
}
```

### 3. Safety Features

- **Failsafe**: Move mouse to screen corner to abort (pyautogui feature)
- **Rate limiting**: 1-second pause between actions
- **Command whitelist**: Only safe shell commands allowed
- **Timeout protection**: 30-second timeout for shell commands

## Integration with O.R.I.O.N.

The Vision Loop integrates seamlessly with O.R.I.O.N.'s existing architecture:

```
┌─────────────────────────────────────────────┐
│  O.R.I.O.N. Architecture                    │
├─────────────────────────────────────────────┤
│                                             │
│  Node.js Gateway (TypeScript)               │
│  ├── Browser automation (Playwright)        │
│  ├── Channel integrations (Telegram, etc.)  │
│  └── Agent orchestration                    │
│                                             │
│  Python Brain (Mutable)                     │
│  ├── Memory (ChromaDB)                      │
│  ├── Evolution Engine                       │
│  └── Vision Loop ⭐ NEW                     │
│      ├── Screenshot capture (mss)           │
│      ├── Vision analysis (Gemini)           │
│      └── GUI control (pyautogui)            │
│                                             │
└─────────────────────────────────────────────┘
```

## Troubleshooting

### Issue: "Vision dependencies not installed"

```bash
pip3 install mss pillow pyautogui google-genai
```

### Issue: "GEMINI_API_KEY not set"

```bash
export GEMINI_API_KEY='your-key-here'
```

Get key from: https://aistudio.google.com/apikey

### Issue: "pyautogui not working on Linux"

Install additional dependencies:

```bash
# Ubuntu/Debian
sudo apt-get install python3-tk python3-dev

# For X11 support
sudo apt-get install scrot
```

### Issue: "Permission denied" errors

Run with sudo or adjust permissions:

```bash
# Allow input events (Linux)
sudo chmod +x /dev/input/event*
```

Or run in trust mode for testing:

```python
executive = OrionExecutive(trust_mode=True)
```

## Performance Tips

1. **Use trust_mode=True for batch operations** (after testing)
2. **Reuse screenshot data** instead of re-capturing
3. **Set max_attempts=1** if you're confident in coordinates
4. **Disable verification** for faster execution

```python
# Fast mode (no prompts, no verification)
executive = OrionExecutive(trust_mode=True)
result = executive.vision_loop(
    task="click the icon",
    max_attempts=1,
    verify=False
)
```

## Examples

See `demo_vision_loop.py` for complete examples:

```bash
python3 demo_vision_loop.py
```

## Future Enhancements

Planned features:

- [ ] OCR text extraction from screenshots
- [ ] Multi-monitor support
- [ ] Mouse gesture recording/playback
- [ ] Visual regression testing
- [ ] Integration with Node.js gateway via IPC
- [ ] Real-time screen monitoring
- [ ] Keyboard macro recording

## License

Part of the O.R.I.O.N./OpenClaw project.
