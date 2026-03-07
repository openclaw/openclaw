"""
Creative Content Generator Agent

A simple example agent that demonstrates the SotyBot agent interface.
This agent generates creative content without requiring external APIs.
"""

import random
from typing import Any, Dict, List, Optional

from engine.agents.base import BaseAgent


class CreativeWriterAgent(BaseAgent):
    """
    Creative content generation agent.
    
    Domain: creative
    Risk Level: read_only (no external actions)
    """
    
    def __init__(self) -> None:
        super().__init__()
        self.tone = "creative"
        self.max_length = 1000
    
    async def initialize(self, config: Dict[str, Any]) -> None:
        """Initialize with configuration"""
        self.tone = config.get("tone", "creative")
        self.max_length = config.get("max_length", 1000)
        self.mark_initialized()
    
    async def execute(self, task: str, context: Optional[Dict[str, Any]] = None) -> Any:
        """
        Execute a creative writing task.
        
        Supports:
        - "generate blog ideas about [topic]"
        - "write social media post about [topic]"
        - "brainstorm [topic]"
        - "create story prompt"
        """
        task_lower = task.lower()
        
        try:
            if "blog" in task_lower and "idea" in task_lower:
                result = self._generate_blog_ideas(task)
            elif "social media" in task_lower or "tweet" in task_lower:
                result = self._generate_social_post(task)
            elif "brainstorm" in task_lower:
                result = self._brainstorm(task)
            elif "story" in task_lower or "prompt" in task_lower:
                result = self._generate_story_prompt()
            else:
                result = self._general_creative_response(task)
            
            self.record_execution(success=True)
            return result
            
        except Exception as e:
            self.record_execution(success=False)
            raise
    
    def get_capabilities(self) -> List[str]:
        """Get agent capabilities"""
        return [
            "Generate blog post ideas and outlines",
            "Create social media content",
            "Brainstorm creative concepts",
            "Write short stories and scripts",
            "Generate marketing copy",
            "Provide writing prompts and inspiration",
        ]
    
    async def cleanup(self) -> None:
        """Cleanup resources"""
        pass
    
    # ========================================================================
    # Creative Generation Methods
    # ========================================================================
    
    def _generate_blog_ideas(self, task: str) -> Dict[str, Any]:
        """Generate blog post ideas"""
        # Extract topic from task
        topic = task.split("about")[-1].strip() if "about" in task else "general topics"
        
        ideas = [
            f"The Ultimate Guide to {topic}: Everything You Need to Know",
            f"10 Surprising Facts About {topic} That Will Change Your Perspective",
            f"How {topic} is Transforming the Industry in 2026",
            f"{topic} 101: A Beginner's Journey",
            f"The Future of {topic}: Trends and Predictions",
        ]
        
        return {
            "type": "blog_ideas",
            "topic": topic,
            "ideas": ideas,
            "outlines": [
                {
                    "title": ideas[0],
                    "sections": [
                        "Introduction: Why this matters",
                        f"Understanding {topic}",
                        "Key concepts and principles",
                        "Practical applications",
                        "Common mistakes to avoid",
                        "Conclusion and next steps",
                    ]
                }
            ]
        }
    
    def _generate_social_post(self, task: str) -> Dict[str, Any]:
        """Generate social media post"""
        topic = task.split("about")[-1].strip() if "about" in task else "innovation"
        
        posts = [
            f"🚀 Excited to share insights on {topic}! Here's what I've learned...",
            f"💡 {topic} is changing the game. Here are 3 key takeaways:",
            f"🔥 Hot take: {topic} is more important than ever. Here's why:",
        ]
        
        return {
            "type": "social_media",
            "topic": topic,
            "posts": posts,
            "hashtags": [f"#{topic.replace(' ', '')}", "#Innovation", "#Tech", "#Future"],
        }
    
    def _brainstorm(self, task: str) -> Dict[str, Any]:
        """Brainstorm ideas"""
        topic = task.replace("brainstorm", "").strip()
        
        return {
            "type": "brainstorm",
            "topic": topic,
            "ideas": [
                f"Explore {topic} from a completely new angle",
                f"Combine {topic} with unexpected elements",
                f"Challenge assumptions about {topic}",
                f"Find the human story in {topic}",
                f"Look at {topic} through different time periods",
            ],
            "questions": [
                f"What if {topic} didn't exist?",
                f"How would a child explain {topic}?",
                f"What's the opposite of {topic}?",
            ]
        }
    
    def _generate_story_prompt(self) -> Dict[str, Any]:
        """Generate creative story prompt"""
        settings = ["a futuristic city", "an abandoned space station", "a hidden library", "a parallel dimension"]
        characters = ["a rogue AI", "a time traveler", "a forgotten hero", "an unlikely duo"]
        conflicts = ["must prevent a catastrophe", "searches for truth", "faces an impossible choice", "discovers a secret"]
        
        return {
            "type": "story_prompt",
            "prompt": f"In {random.choice(settings)}, {random.choice(characters)} {random.choice(conflicts)}.",
            "themes": ["identity", "sacrifice", "discovery", "transformation"],
            "mood": random.choice(["mysterious", "hopeful", "tense", "whimsical"]),
        }
    
    def _general_creative_response(self, task: str) -> Dict[str, Any]:
        """General creative response"""
        return {
            "type": "general",
            "task": task,
            "response": f"I can help with creative tasks! Try asking me to:\n"
                       f"- Generate blog ideas about [topic]\n"
                       f"- Write a social media post about [topic]\n"
                       f"- Brainstorm [topic]\n"
                       f"- Create a story prompt",
            "capabilities": self.get_capabilities(),
        }


# Agent instance (will be loaded by the engine)
agent = CreativeWriterAgent()
