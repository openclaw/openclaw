#!/usr/bin/env python3
"""
O.R.I.O.N. Vision Loop Demo
===========================
Demonstrates visual desktop automation using the Vision Loop system.

The Vision Loop: Snapshot → Analyze → Action → Verify

This script shows how O.R.I.O.N. can:
1. See your screen using computer vision
2. Identify UI elements (buttons, text fields, icons)
3. Interact with ANY application (not just browsers)
4. Bridge between applications (e.g., Excel → YouTube)
"""

import sys
import os
from pathlib import Path

# Add modules directory to path
sys.path.insert(0, str(Path(__file__).parent / "modules"))

from executive import OrionExecutive


def demo_screenshot():
    """Demo 1: Basic screenshot capture"""
    print("\n" + "=" * 70)
    print("DEMO 1: Screenshot Capture")
    print("=" * 70)

    executive = OrionExecutive(trust_mode=True)

    print("\n📸 Taking a screenshot of your current screen...")
    result = executive.capture_screenshot()

    if result["success"]:
        print(f"✅ Screenshot saved: {result['path']}")
        print(f"   Resolution: {result['size']}")
    else:
        print(f"❌ Failed: {result['error']}")

    return result


def demo_screen_analysis(screenshot_data=None):
    """Demo 2: Analyze screen and find elements"""
    print("\n" + "=" * 70)
    print("DEMO 2: Screen Analysis with Vision")
    print("=" * 70)

    executive = OrionExecutive(trust_mode=True)

    # Example queries
    queries = [
        "identify all application icons visible on the screen",
        "find any text input fields or search bars",
        "locate the taskbar or dock at the bottom/top of the screen"
    ]

    for i, query in enumerate(queries, 1):
        print(f"\n🧠 Query {i}: {query}")
        result = executive.analyze_screen(query, screenshot_data)

        if result["success"]:
            print(f"✅ Analysis complete!")
            print(f"   Analysis: {result['analysis'][:300]}...")
            if result["coordinates"]:
                print(f"   Found {len(result['coordinates'])} coordinate(s):")
                for coord in result["coordinates"]:
                    print(f"      • {coord}")
        else:
            print(f"❌ Failed: {result['error']}")

        print()


def demo_vision_loop():
    """Demo 3: Full Vision Loop - Find and click an element"""
    print("\n" + "=" * 70)
    print("DEMO 3: Complete Vision Loop")
    print("=" * 70)
    print("\nThis will demonstrate the full Vision Loop cycle:")
    print("  1. Snapshot - Capture your screen")
    print("  2. Analyze  - Find the UI element using AI vision")
    print("  3. Action   - Click the element")
    print("  4. Verify   - Take another screenshot to confirm")

    executive = OrionExecutive(trust_mode=False)  # Require confirmation

    # Example task
    task = input("\n📝 What should I click? (e.g., 'browser icon', 'terminal icon'): ").strip()

    if not task:
        print("⚠️ No task provided, using default: 'browser icon'")
        task = "browser icon"

    print(f"\n🚀 Starting Vision Loop for task: '{task}'")

    result = executive.vision_loop(
        task=f"click the {task}",
        max_attempts=3,
        verify=True
    )

    if result["success"]:
        print(f"\n✅ SUCCESS! Task completed in {len(result['attempts'])} attempt(s)")

        # Show details of successful attempt
        success_attempt = result["attempts"][-1]
        print(f"\n📊 Details:")
        print(f"   Before: {success_attempt.get('screenshot_before', 'N/A')}")
        print(f"   Clicked: ({success_attempt['coordinates']['x']}, {success_attempt['coordinates']['y']})")
        print(f"   After: {success_attempt.get('screenshot_after', 'N/A')}")
    else:
        print(f"\n❌ FAILED after {len(result['attempts'])} attempts")
        for i, attempt in enumerate(result["attempts"], 1):
            print(f"\n   Attempt {i}:")
            if "error" in attempt:
                print(f"      Error: {attempt['error']}")


def demo_app_bridging():
    """Demo 4: Bridge between applications (Excel → Browser)"""
    print("\n" + "=" * 70)
    print("DEMO 4: Application Bridging")
    print("=" * 70)
    print("\nThis demonstrates bridging data between applications.")
    print("Example: Read data from a spreadsheet and search it on YouTube")

    executive = OrionExecutive(trust_mode=False)

    # Step 1: Take screenshot to see what's on screen
    print("\n📸 Step 1: Capturing current screen state...")
    screenshot = executive.capture_screenshot()

    # Step 2: Find the Excel/spreadsheet window
    print("\n🔍 Step 2: Looking for spreadsheet data...")
    analysis = executive.analyze_screen(
        "find any spreadsheet or document with visible text data. "
        "If found, read the text in cell A1 or the first visible cell.",
        screenshot
    )

    if analysis["success"]:
        print(f"   Analysis: {analysis['analysis'][:200]}")

        # Extract the data from analysis (this would need OCR or better parsing)
        search_term = input("\n📝 What should I search for? (or press Enter to skip): ").strip()

        if search_term:
            # Step 3: Switch to browser and perform search
            print(f"\n🔍 Step 3: Searching for '{search_term}' in browser...")

            # First, find and click the browser
            executive.vision_loop("click the browser icon or window")

            # Then find the search bar
            executive.vision_loop("click the search bar or address bar")

            # Type the search term
            if executive.gui_control("type", text=search_term)["success"]:
                print(f"✅ Typed: {search_term}")

                # Press Enter to search
                executive.gui_control("hotkey", text="enter")
                print("✅ Executed search!")
    else:
        print(f"❌ Failed: {analysis['error']}")


def main():
    """Main demo menu"""
    print("=" * 70)
    print("O.R.I.O.N. VISION LOOP - Interactive Demo")
    print("=" * 70)
    print("\nUpgraded capabilities:")
    print("  ✓ Visual desktop automation")
    print("  ✓ Cross-application control")
    print("  ✓ AI-powered element detection")
    print("  ✓ Verification loop")

    while True:
        print("\n" + "=" * 70)
        print("Select a demo:")
        print("  1. Screenshot Capture")
        print("  2. Screen Analysis (Vision)")
        print("  3. Vision Loop (Find & Click)")
        print("  4. App Bridging (Advanced)")
        print("  5. Run All Demos")
        print("  0. Exit")
        print("=" * 70)

        choice = input("\nChoice: ").strip()

        if choice == "0":
            print("\n👋 Goodbye!")
            break
        elif choice == "1":
            demo_screenshot()
        elif choice == "2":
            screenshot = demo_screenshot()
            if screenshot.get("success"):
                demo_screen_analysis(screenshot)
        elif choice == "3":
            demo_vision_loop()
        elif choice == "4":
            demo_app_bridging()
        elif choice == "5":
            screenshot = demo_screenshot()
            if screenshot.get("success"):
                demo_screen_analysis(screenshot)
            demo_vision_loop()
            demo_app_bridging()
        else:
            print("❌ Invalid choice")


if __name__ == "__main__":
    main()
