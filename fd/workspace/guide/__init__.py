"""OpenClaw Guide — built-in instructional and support layer.

Helps operators understand, navigate, and use every part of OpenClaw
through plain-English guidance, contextual help, and step-by-step plans.
"""

from .capabilities import CAPABILITIES
from .contextual_help import HELP_SECTIONS, ContextualHelpProvider
from .engine import OpenClawGuideEngine
from .howto import HowToPlanner
from .walkthrough import WalkthroughEngine

__all__ = [
    "CAPABILITIES",
    "ContextualHelpProvider",
    "HELP_SECTIONS",
    "HowToPlanner",
    "OpenClawGuideEngine",
    "WalkthroughEngine",
]
