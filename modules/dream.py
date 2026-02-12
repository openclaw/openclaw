"""
O.R.I.O.N. SKILL MODULE: THE DREAM STATE
=========================================
This file is part of THE LAB - Updatable skills and plugins.
Status: UPDATABLE - Can be improved through the Evolution Engine.

The Dream module processes daily experiences (logs) and consolidates
them into long-term memories using LLM-based summarization.
"""

import os
import sys
from datetime import datetime
from typing import List, Dict, Any, Tuple
import json
import requests
import re
import glob

# Import the core memory system (immutable dependency)
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from core.memory import remember, remember_preference


class DreamState:
    """
    Nightly Learning Process - Consolidates daily logs into memories.
    Inspired by human REM sleep and memory consolidation.
    """

    def __init__(self, ollama_host: str = "http://localhost:11434"):
        """
        Initialize the Dream State processor.

        Args:
            ollama_host: URL of the Ollama server (default: localhost:11434)
        """
        self.ollama_host = ollama_host
        self.model = "llama3"  # Using Llama 3 for summarization

        # Regex patterns for extracting user preferences from logs
        self.preference_patterns = [
            r"I like (.+?)(?:\.|$|;)",
            r"I prefer (.+?)(?:\.|$|;)",
            r"Don't (.+?)(?:\.|$|;)",
            r"Never (.+?)(?:\.|$|;)",
            r"Always (.+?)(?:\.|$|;)",
            r"I want (.+?)(?:\.|$|;)",
            r"Please (.+?)(?:\.|$|;)",
        ]

    def _extract_preferences(self, log_content: str) -> List[Tuple[str, str]]:
        """
        Extract user preference statements from logs using pattern matching.

        Looks for phrases like:
        - "I like..."
        - "I prefer..."
        - "Don't..."
        - "Never..."
        - "Always..."

        Args:
            log_content: Raw log text to parse

        Returns:
            List of tuples: (preference_text, original_context)
        """
        preferences = []
        lines = log_content.split('\n')

        for line in lines:
            # Check each preference pattern
            for pattern in self.preference_patterns:
                matches = re.finditer(pattern, line, re.IGNORECASE)
                for match in matches:
                    preference_text = match.group(0).strip()

                    # Determine category based on pattern
                    if re.search(r'\b(code|coding|function|variable|style|format)\b', preference_text, re.IGNORECASE):
                        category = "coding_style"
                    elif re.search(r'\b(workflow|process|work|method)\b', preference_text, re.IGNORECASE):
                        category = "workflow"
                    elif re.search(r'\b(explain|communicate|tell|say)\b', preference_text, re.IGNORECASE):
                        category = "communication"
                    else:
                        category = "general"

                    preferences.append((preference_text, category))

        return preferences

    def _check_ollama_connection(self) -> bool:
        """
        Verify that Ollama is running and accessible.

        Returns:
            True if connected, False otherwise
        """
        try:
            response = requests.get(f"{self.ollama_host}/api/tags", timeout=5)
            return response.status_code == 200
        except Exception as e:
            print(f"⚠️ Cannot connect to Ollama: {e}")
            return False

    def _summarize_with_llm(self, log_content: str) -> List[str]:
        """
        Use Llama 3 to extract key learnings from logs.

        Args:
            log_content: Raw log text to summarize

        Returns:
            List of bullet-point summaries
        """
        prompt = f"""You are O.R.I.O.N., an AI system reviewing your daily activity logs.
Extract the most important facts, learnings, and insights from these logs.

Format your response as concise bullet points (one insight per line).
Focus on:
- New knowledge or skills acquired
- Important decisions or conclusions
- User preferences or patterns
- System improvements or changes

Logs:
{log_content}

Key Learnings (bullet points only):"""

        try:
            # Call Ollama API
            response = requests.post(
                f"{self.ollama_host}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False
                },
                timeout=60
            )

            if response.status_code == 200:
                result = response.json()
                summary_text = result.get("response", "")

                # Parse bullet points
                lines = [line.strip() for line in summary_text.split('\n') if line.strip()]
                # Filter for lines that look like bullet points
                bullet_points = [
                    line.lstrip('•-*').strip()
                    for line in lines
                    if line and not line.endswith(':')
                ]

                return bullet_points
            else:
                print(f"❌ LLM request failed: {response.status_code}")
                return []

        except Exception as e:
            print(f"❌ Error during LLM summarization: {e}")
            return []

    def find_log_files(self, directory: str = ".") -> List[str]:
        """
        Find all .log files in the specified directory.

        Args:
            directory: Directory to search (default: current directory)

        Returns:
            List of .log file paths
        """
        log_pattern = os.path.join(directory, "*.log")
        log_files = glob.glob(log_pattern)
        return log_files

    def process_logs(self, log_file_path: str) -> Dict[str, Any]:
        """
        Main dream cycle: Read logs, summarize, and store in memory.

        Args:
            log_file_path: Path to the daily log file

        Returns:
            Dict with statistics about the dream cycle
        """
        print("\n" + "=" * 60)
        print("🌙 ENTERING DREAM STATE...")
        print("=" * 60)
        print(f"📖 Processing logs from: {log_file_path}")

        # Check Ollama connection
        if not self._check_ollama_connection():
            print("⚠️ Ollama not available. Using fallback mode.")
            return {"status": "failed", "reason": "ollama_unavailable"}

        # Read the log file
        try:
            with open(log_file_path, 'r', encoding='utf-8') as f:
                log_content = f.read()
        except FileNotFoundError:
            print(f"❌ Log file not found: {log_file_path}")
            return {"status": "failed", "reason": "file_not_found"}
        except Exception as e:
            print(f"❌ Error reading log file: {e}")
            return {"status": "failed", "reason": str(e)}

        if not log_content.strip():
            print("⚠️ Log file is empty. Nothing to process.")
            return {"status": "skipped", "reason": "empty_logs"}

        print(f"📊 Log size: {len(log_content)} characters")

        # PHASE 1: Extract explicit preferences (pattern matching - works offline)
        print("⭐ Extracting user preferences...")
        preferences = self._extract_preferences(log_content)

        if preferences:
            print(f"✨ Found {len(preferences)} explicit preference(s)")
            for i, (pref_text, category) in enumerate(preferences, 1):
                print(f"  {i}. [{category}] {pref_text[:60]}...")
                remember_preference(pref_text, category)
        else:
            print("  No explicit preferences found in this log")

        # PHASE 2: Summarize with LLM (requires Ollama)
        print("\n🤖 Analyzing logs with Llama 3...")
        learnings = self._summarize_with_llm(log_content)

        if not learnings:
            print("⚠️ No learnings extracted from logs.")
            return {"status": "completed", "memories_stored": 0}

        print(f"✨ Extracted {len(learnings)} key insights")

        # Store each learning as a memory
        stored_count = 0
        for i, learning in enumerate(learnings, 1):
            print(f"  {i}. {learning[:80]}...")

            # Store in long-term memory
            remember(
                text=learning,
                metadata={
                    "type": "dream_learning",
                    "source": "daily_logs",
                    "log_file": os.path.basename(log_file_path),
                    "dream_date": datetime.now().isoformat()
                }
            )
            stored_count += 1

        print("\n" + "=" * 60)
        print(f"😴 DREAM CYCLE COMPLETE - {len(preferences)} preferences + {stored_count} memories consolidated")
        print("=" * 60 + "\n")

        return {
            "status": "completed",
            "preferences_stored": len(preferences),
            "memories_stored": stored_count,
            "log_file": log_file_path,
            "processed_at": datetime.now().isoformat()
        }

    def process_all_logs(self, directory: str = ".") -> Dict[str, Any]:
        """
        Find and process all .log files in a directory.

        Args:
            directory: Directory to search for .log files

        Returns:
            Summary statistics for all processed logs
        """
        print("\n" + "=" * 60)
        print("🌙 DREAM STATE - BATCH PROCESSING")
        print("=" * 60)

        log_files = self.find_log_files(directory)

        if not log_files:
            print(f"⚠️ No .log files found in {directory}")
            return {"status": "no_logs_found", "files_processed": 0}

        print(f"📁 Found {len(log_files)} log file(s)")

        total_preferences = 0
        total_memories = 0
        processed_files = 0

        for log_file in log_files:
            result = self.process_logs(log_file)
            if result["status"] == "completed":
                total_preferences += result.get("preferences_stored", 0)
                total_memories += result.get("memories_stored", 0)
                processed_files += 1

        print("\n" + "=" * 60)
        print(f"🌟 BATCH COMPLETE")
        print(f"   Files processed: {processed_files}/{len(log_files)}")
        print(f"   Preferences stored: {total_preferences}")
        print(f"   Memories stored: {total_memories}")
        print("=" * 60 + "\n")

        return {
            "status": "completed",
            "files_processed": processed_files,
            "total_preferences": total_preferences,
            "total_memories": total_memories
        }

    def create_mock_logs(self, output_path: str = "./daily_log.txt") -> str:
        """
        Create a mock daily log file for testing.

        Args:
            output_path: Where to save the mock log

        Returns:
            Path to the created log file
        """
        mock_logs = """
[2026-02-11 08:00:00] System initialized. Kernel/Plugin architecture loaded.
[2026-02-11 08:05:23] User requested implementation of Memory system using ChromaDB.
[2026-02-11 08:15:47] Created core/memory.py with vector embedding capabilities.
[2026-02-11 08:30:12] User emphasized importance of protecting core/ directory from updates.
[2026-02-11 09:00:45] Implemented kernel_guard.py to verify file integrity before updates.
[2026-02-11 10:15:33] User prefers bullet-point summaries over verbose explanations.
[2026-02-11 11:30:22] Discovered that O.R.I.O.N. uses Ollama for local LLM processing.
[2026-02-11 14:00:15] Evolution engine design reviewed - focus on safe self-improvement.
[2026-02-11 15:45:08] User values efficiency and token governance for cost savings.
[2026-02-11 16:30:55] Dream module created to consolidate daily learnings into memories.
"""

        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(mock_logs.strip())

        print(f"📝 Mock log file created: {output_path}")
        return output_path


if __name__ == "__main__":
    # Test the Dream State
    print("O.R.I.O.N. DREAM STATE TEST")

    dreamer = DreamState()

    # Create mock logs if they don't exist
    log_path = "./daily_log.txt"
    if not os.path.exists(log_path):
        dreamer.create_mock_logs(log_path)

    # Process the logs
    result = dreamer.process_logs(log_path)

    print("\nDream cycle result:")
    print(json.dumps(result, indent=2))
