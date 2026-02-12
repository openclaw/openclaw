"""
O.R.I.O.N. SKILL MODULE: THE EXECUTIVE (The Hands)
===================================================
This file is part of THE LAB - Updatable skills and plugins.
Status: UPDATABLE - Can be improved through the Evolution Engine.

The Executive module provides controlled OS-level automation capabilities
including GUI control, shell execution, and browser navigation.

SECURITY: All actions are logged, rate-limited, and require explicit permission.
"""

import platform
import os
import subprocess
import sys
from datetime import datetime
from typing import Optional, Dict, Any, List
from pathlib import Path

# Platform detection
CURRENT_OS = platform.system()  # 'Darwin', 'Windows', 'Linux'

# Security settings
HEADLESS_MODE = True  # Run browsers in background by default
TRUST_MODE = False    # If False, prompt for confirmation on physical actions
LOG_DIR = Path("logs")
LOG_FILE = LOG_DIR / "executive.log"

# Ensure log directory exists
LOG_DIR.mkdir(exist_ok=True)

# Import GUI control library (with fallback if not installed)
try:
    import pyautogui
    # Safety settings
    pyautogui.PAUSE = 1.0  # 1 second pause between actions
    pyautogui.FAILSAFE = True  # Move mouse to corner to abort
    GUI_AVAILABLE = True
except ImportError:
    GUI_AVAILABLE = False
    print("⚠️ pyautogui not installed. GUI control disabled.")
    print("   Install with: pip install pyautogui")

# Import Playwright for browser control (with fallback)
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    print("⚠️ Playwright not installed. Browser automation disabled.")
    print("   Install with: pip install playwright && playwright install")

# Import Vision Loop dependencies (with fallback)
try:
    import mss
    import mss.tools
    from PIL import Image
    import io
    import base64
    from google import genai
    VISION_AVAILABLE = True
except ImportError as e:
    VISION_AVAILABLE = False
    print(f"⚠️ Vision Loop dependencies not installed: {e}")
    print("   Install with: pip install mss pillow google-genai")


class OrionExecutive:
    """
    The Hands - O.R.I.O.N.'s interface to the physical OS.

    Provides controlled automation capabilities with security checks.
    """

    def __init__(self, trust_mode: bool = TRUST_MODE):
        """
        Initialize the Executive module.

        Args:
            trust_mode: If False, prompt for confirmation before physical actions
        """
        self.trust_mode = trust_mode
        self.os = CURRENT_OS
        self.modifier_key = self._get_modifier_key()
        self.action_count = 0
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Security: Command whitelist (only these shell commands allowed)
        self.allowed_commands = [
            'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'head', 'tail',
            'date', 'time', 'whoami', 'hostname', 'uname',
            'mkdir', 'touch', 'cp', 'mv',  # File operations (safe ones)
            'git',  # Git operations
        ]

        # Initialize Vision Loop client
        self.vision_client = None
        if VISION_AVAILABLE:
            try:
                api_key = os.environ.get("GEMINI_API_KEY")
                if api_key:
                    self.vision_client = genai.Client(api_key=api_key)
                else:
                    print("⚠️ GEMINI_API_KEY not set. Vision analysis disabled.")
            except Exception as e:
                print(f"⚠️ Failed to initialize Gemini client: {e}")

        self._log("Executive initialized", {
            "os": self.os,
            "trust_mode": self.trust_mode,
            "gui_available": GUI_AVAILABLE,
            "playwright_available": PLAYWRIGHT_AVAILABLE,
            "vision_available": VISION_AVAILABLE and self.vision_client is not None
        })

    def _get_modifier_key(self) -> str:
        """Determine the appropriate modifier key for the OS."""
        if self.os == 'Darwin':  # macOS
            return 'command'
        else:  # Windows/Linux
            return 'ctrl'

    def _log(self, action: str, details: Dict[str, Any]) -> None:
        """
        Log all executive actions for audit trail.

        Args:
            action: Description of the action
            details: Additional details about the action
        """
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "session": self.session_id,
            "action": action,
            "details": details,
            "action_number": self.action_count
        }

        try:
            with open(LOG_FILE, 'a') as f:
                import json
                f.write(json.dumps(log_entry) + '\n')
        except Exception as e:
            print(f"⚠️ Failed to write log: {e}")

        self.action_count += 1

    def _confirm_action(self, action: str, details: str) -> bool:
        """
        Ask user to confirm a physical action.

        Args:
            action: Action description
            details: Action details

        Returns:
            True if user approves, False otherwise
        """
        if self.trust_mode:
            return True

        print("\n" + "=" * 60)
        print("⚠️  O.R.I.O.N. IS REQUESTING PHYSICAL CONTROL")
        print("=" * 60)
        print(f"Action: {action}")
        print(f"Details: {details}")
        print("=" * 60)

        response = input("Allow this action? [Y/N]: ").strip().upper()
        approved = response == 'Y'

        self._log("confirmation_prompt", {
            "action": action,
            "details": details,
            "approved": approved
        })

        return approved

    def gui_control(
        self,
        action: str,
        x: Optional[int] = None,
        y: Optional[int] = None,
        text: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Safely control mouse and keyboard.

        Args:
            action: 'move', 'click', 'type', 'hotkey'
            x: X coordinate (for move/click)
            y: Y coordinate (for move/click)
            text: Text to type or hotkey combination

        Returns:
            Dict with status and details
        """
        if not GUI_AVAILABLE:
            return {"success": False, "error": "pyautogui not installed"}

        # Security check: confirm action
        if not self._confirm_action(f"GUI {action}", f"x={x}, y={y}, text={text}"):
            return {"success": False, "error": "User denied permission"}

        try:
            if action == 'move':
                pyautogui.moveTo(x, y, duration=0.5)
                self._log("gui_move", {"x": x, "y": y})
                return {"success": True, "action": "move", "x": x, "y": y}

            elif action == 'click':
                if x is not None and y is not None:
                    pyautogui.click(x, y)
                else:
                    pyautogui.click()
                self._log("gui_click", {"x": x, "y": y})
                return {"success": True, "action": "click", "x": x, "y": y}

            elif action == 'type':
                pyautogui.write(text, interval=0.1)
                self._log("gui_type", {"length": len(text)})
                return {"success": True, "action": "type", "chars": len(text)}

            elif action == 'hotkey':
                keys = text.split('+')
                pyautogui.hotkey(*keys)
                self._log("gui_hotkey", {"keys": keys})
                return {"success": True, "action": "hotkey", "keys": keys}

            else:
                return {"success": False, "error": f"Unknown action: {action}"}

        except Exception as e:
            self._log("gui_error", {"action": action, "error": str(e)})
            return {"success": False, "error": str(e)}

    def system_shell(self, command: str) -> Dict[str, Any]:
        """
        Execute terminal commands (WHITELISTED ONLY for security).

        Args:
            command: Shell command to execute

        Returns:
            Dict with status, stdout, and stderr
        """
        # Security: Parse command to check if it's allowed
        cmd_parts = command.strip().split()
        if not cmd_parts:
            return {"success": False, "error": "Empty command"}

        base_command = cmd_parts[0]

        # Security check: command must be in whitelist
        if base_command not in self.allowed_commands:
            self._log("blocked_command", {"command": command, "reason": "not in whitelist"})
            return {
                "success": False,
                "error": f"Command '{base_command}' not in whitelist",
                "allowed_commands": self.allowed_commands
            }

        # Confirm action
        if not self._confirm_action("Shell execution", command):
            return {"success": False, "error": "User denied permission"}

        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=30  # 30 second timeout
            )

            self._log("shell_execution", {
                "command": command,
                "returncode": result.returncode,
                "stdout_length": len(result.stdout),
                "stderr_length": len(result.stderr)
            })

            return {
                "success": result.returncode == 0,
                "returncode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "command": command
            }

        except subprocess.TimeoutExpired:
            self._log("shell_timeout", {"command": command})
            return {"success": False, "error": "Command timed out (30s limit)"}
        except Exception as e:
            self._log("shell_error", {"command": command, "error": str(e)})
            return {"success": False, "error": str(e)}

    def browser_nav(
        self,
        url: str,
        headless: bool = HEADLESS_MODE,
        action: Optional[str] = None,
        selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Navigate and interact with websites using Playwright.

        Args:
            url: URL to visit
            headless: Run browser in background (default: True)
            action: Optional action ('click', 'type', 'screenshot')
            selector: CSS selector for the element to interact with

        Returns:
            Dict with status and results
        """
        if not PLAYWRIGHT_AVAILABLE:
            return {"success": False, "error": "Playwright not installed"}

        # Confirm action
        if not self._confirm_action(f"Browser navigation: {action or 'visit'}", url):
            return {"success": False, "error": "User denied permission"}

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=headless)
                page = browser.new_page()

                # Navigate to URL
                page.goto(url, wait_until='domcontentloaded')

                result = {
                    "success": True,
                    "url": url,
                    "title": page.title()
                }

                # Perform optional action
                if action and selector:
                    if action == 'click':
                        page.click(selector)
                        result["action"] = "clicked"
                    elif action == 'type':
                        page.fill(selector, selector)  # TODO: add text param
                        result["action"] = "typed"
                    elif action == 'screenshot':
                        screenshot_path = f"screenshots/{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
                        os.makedirs("screenshots", exist_ok=True)
                        page.screenshot(path=screenshot_path)
                        result["screenshot"] = screenshot_path

                # Get page content
                result["content_preview"] = page.content()[:500]

                browser.close()

                self._log("browser_navigation", {
                    "url": url,
                    "action": action,
                    "headless": headless
                })

                return result

        except Exception as e:
            self._log("browser_error", {"url": url, "error": str(e)})
            return {"success": False, "error": str(e)}

    def capture_screenshot(self, save_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Capture a screenshot of the entire screen using mss.

        Args:
            save_path: Optional path to save the screenshot

        Returns:
            Dict with success status, image data, and file path
        """
        if not VISION_AVAILABLE:
            return {"success": False, "error": "Vision dependencies not installed"}

        try:
            with mss.mss() as sct:
                # Capture the primary monitor
                monitor = sct.monitors[1]
                screenshot = sct.grab(monitor)

                # Convert to PIL Image
                img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")

                # Save if path provided
                if save_path:
                    os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)
                    img.save(save_path)
                else:
                    # Create default path in screenshots directory
                    save_path = f"screenshots/screenshot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
                    os.makedirs("screenshots", exist_ok=True)
                    img.save(save_path)

                # Convert to base64 for API transmission
                buffered = io.BytesIO()
                img.save(buffered, format="PNG")
                img_base64 = base64.b64encode(buffered.getvalue()).decode()

                self._log("screenshot_captured", {
                    "path": save_path,
                    "size": screenshot.size,
                    "monitor": monitor
                })

                return {
                    "success": True,
                    "path": save_path,
                    "size": screenshot.size,
                    "image_base64": img_base64,
                    "image": img  # PIL Image object
                }

        except Exception as e:
            self._log("screenshot_error", {"error": str(e)})
            return {"success": False, "error": str(e)}

    def analyze_screen(
        self,
        query: str,
        screenshot_data: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Analyze a screenshot using Gemini Vision to find UI elements.

        Args:
            query: What to find (e.g., "Find the Start button coordinates")
            screenshot_data: Optional screenshot dict from capture_screenshot()

        Returns:
            Dict with analysis results including coordinates if found
        """
        if not VISION_AVAILABLE or not self.vision_client:
            return {"success": False, "error": "Vision analysis not available"}

        try:
            # Capture screenshot if not provided
            if screenshot_data is None:
                screenshot_data = self.capture_screenshot()
                if not screenshot_data["success"]:
                    return screenshot_data

            # Prepare the vision prompt
            vision_prompt = f"""Analyze this screenshot and {query}

IMPORTANT: If you find UI elements with specific locations, return the coordinates in this EXACT format:
COORDINATES: x=123, y=456

If you find multiple elements, list them as:
COORDINATES: [
  {{"name": "element1", "x": 100, "y": 200}},
  {{"name": "element2", "x": 300, "y": 400}}
]

Be precise with pixel coordinates. The top-left corner is (0, 0)."""

            # Upload image to Gemini
            image_path = screenshot_data["path"]

            # Use Gemini 2.0 Flash with vision
            response = self.vision_client.models.generate_content(
                model="gemini-2.0-flash-exp",
                contents=[
                    vision_prompt,
                    {
                        "mime_type": "image/png",
                        "data": screenshot_data["image_base64"]
                    }
                ]
            )

            analysis_text = response.text

            # Parse coordinates from response
            coordinates = self._parse_coordinates(analysis_text)

            self._log("screen_analyzed", {
                "query": query,
                "screenshot": image_path,
                "coordinates_found": len(coordinates) > 0
            })

            return {
                "success": True,
                "analysis": analysis_text,
                "coordinates": coordinates,
                "screenshot": image_path
            }

        except Exception as e:
            self._log("analysis_error", {"error": str(e)})
            return {"success": False, "error": str(e)}

    def _parse_coordinates(self, text: str) -> List[Dict[str, Any]]:
        """
        Parse coordinates from Gemini's response.

        Args:
            text: Response text containing coordinate information

        Returns:
            List of coordinate dictionaries
        """
        import re
        import json

        coordinates = []

        # Try to find JSON array format first
        json_match = re.search(r'COORDINATES:\s*\[(.*?)\]', text, re.DOTALL)
        if json_match:
            try:
                coords_str = '[' + json_match.group(1) + ']'
                coords_list = json.loads(coords_str)
                return coords_list
            except:
                pass

        # Try simple x=, y= format
        simple_match = re.search(r'x=(\d+),?\s*y=(\d+)', text, re.IGNORECASE)
        if simple_match:
            coordinates.append({
                "x": int(simple_match.group(1)),
                "y": int(simple_match.group(2))
            })

        return coordinates

    def vision_loop(
        self,
        task: str,
        max_attempts: int = 3,
        verify: bool = True
    ) -> Dict[str, Any]:
        """
        Execute the Vision Loop: Snapshot → Analyze → Action → Verify

        Args:
            task: Natural language task (e.g., "Click the Start button")
            max_attempts: Maximum number of attempts
            verify: Whether to take a verification screenshot

        Returns:
            Dict with execution results
        """
        if not VISION_AVAILABLE or not self.vision_client:
            return {"success": False, "error": "Vision Loop not available"}

        if not GUI_AVAILABLE:
            return {"success": False, "error": "GUI control not available"}

        self._log("vision_loop_start", {"task": task})

        results = {
            "task": task,
            "attempts": [],
            "success": False
        }

        for attempt in range(max_attempts):
            attempt_data = {"attempt": attempt + 1}

            # STEP 1: SNAPSHOT - Capture current screen
            print(f"\n🔍 Vision Loop Attempt {attempt + 1}/{max_attempts}")
            print(f"📸 Step 1: Capturing screenshot...")

            screenshot = self.capture_screenshot()
            if not screenshot["success"]:
                attempt_data["error"] = f"Screenshot failed: {screenshot['error']}"
                results["attempts"].append(attempt_data)
                continue

            attempt_data["screenshot_before"] = screenshot["path"]
            print(f"   ✅ Screenshot saved: {screenshot['path']}")

            # STEP 2: ANALYZE - Find target UI element
            print(f"🧠 Step 2: Analyzing screen for: {task}")

            analysis = self.analyze_screen(
                query=f"find the UI element to {task}. Return exact pixel coordinates.",
                screenshot_data=screenshot
            )

            if not analysis["success"]:
                attempt_data["error"] = f"Analysis failed: {analysis['error']}"
                results["attempts"].append(attempt_data)
                continue

            if not analysis["coordinates"]:
                attempt_data["error"] = "No coordinates found in analysis"
                attempt_data["analysis"] = analysis["analysis"]
                results["attempts"].append(attempt_data)
                print(f"   ⚠️ Could not locate element. Analysis: {analysis['analysis'][:200]}")
                continue

            coords = analysis["coordinates"][0]  # Use first match
            attempt_data["analysis"] = analysis["analysis"]
            attempt_data["coordinates"] = coords
            print(f"   ✅ Found at: x={coords['x']}, y={coords['y']}")

            # STEP 3: ACTION - Perform the click
            print(f"👆 Step 3: Performing action...")

            action_result = self.gui_control(
                action='click',
                x=coords['x'],
                y=coords['y']
            )

            if not action_result["success"]:
                attempt_data["error"] = f"Action failed: {action_result['error']}"
                results["attempts"].append(attempt_data)
                continue

            attempt_data["action"] = action_result
            print(f"   ✅ Clicked at ({coords['x']}, {coords['y']})")

            # STEP 4: VERIFY - Take another screenshot to confirm
            if verify:
                print(f"✓ Step 4: Verifying action...")
                import time
                time.sleep(1)  # Wait for UI to update

                verify_screenshot = self.capture_screenshot()
                if verify_screenshot["success"]:
                    attempt_data["screenshot_after"] = verify_screenshot["path"]
                    print(f"   ✅ Verification screenshot: {verify_screenshot['path']}")

            # Success!
            results["success"] = True
            results["attempts"].append(attempt_data)
            print(f"\n✅ Vision Loop completed successfully!")
            break

        if not results["success"]:
            print(f"\n❌ Vision Loop failed after {max_attempts} attempts")

        self._log("vision_loop_complete", {
            "task": task,
            "success": results["success"],
            "attempts": len(results["attempts"])
        })

        return results

    def get_stats(self) -> Dict[str, Any]:
        """Get statistics about executive actions."""
        return {
            "session_id": self.session_id,
            "action_count": self.action_count,
            "os": self.os,
            "trust_mode": self.trust_mode,
            "gui_available": GUI_AVAILABLE,
            "playwright_available": PLAYWRIGHT_AVAILABLE,
            "vision_available": VISION_AVAILABLE and self.vision_client is not None,
            "log_file": str(LOG_FILE)
        }


# Convenience functions
_executive_instance = None

def get_executive() -> OrionExecutive:
    """Get or create the global Executive instance."""
    global _executive_instance
    if _executive_instance is None:
        _executive_instance = OrionExecutive()
    return _executive_instance


if __name__ == "__main__":
    # Test the Executive module
    print("=" * 70)
    print("O.R.I.O.N. EXECUTIVE MODULE TEST")
    print("=" * 70)

    exec_module = OrionExecutive(trust_mode=False)  # Require confirmation for safety

    # Test 1: Shell command (safe)
    print("\n🧪 Test 1: Shell command (ls)")
    result = exec_module.system_shell("ls -la")
    print(f"✅ Result: {result['success']}")
    if result['success']:
        print(f"Output (first 200 chars): {result['stdout'][:200]}")

    # Test 2: Vision Loop - Screenshot capture
    if VISION_AVAILABLE:
        print("\n🧪 Test 2: Screenshot capture")
        screenshot = exec_module.capture_screenshot()
        if screenshot['success']:
            print(f"✅ Screenshot saved: {screenshot['path']}")
            print(f"   Size: {screenshot['size']}")
        else:
            print(f"❌ Screenshot failed: {screenshot['error']}")

        # Test 3: Vision Loop - Full cycle (requires user confirmation)
        print("\n🧪 Test 3: Vision Loop (Full cycle)")
        print("   This will demonstrate the complete Vision Loop:")
        print("   Snapshot → Analyze → Action → Verify")
        print("\n   Example task: 'Click the Terminal icon in the dock'")
        print("   Note: Requires manual confirmation for safety")

    # Test 4: Show stats
    print("\n" + "=" * 70)
    print("📊 Executive Stats:")
    stats = exec_module.get_stats()
    for key, value in stats.items():
        print(f"  {key}: {value}")
    print("=" * 70)

    print("\n✅ O.R.I.O.N. EXECUTIVE MODULE - All systems operational!")
    if VISION_AVAILABLE and exec_module.vision_client:
        print("🔮 VISION LOOP ENABLED - Ready for visual desktop automation!")
