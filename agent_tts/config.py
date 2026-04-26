from future import annotations
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, model_validator

from agent_tts.providers import PROVIDERS


class VoiceSettings(BaseModel):
   provider: str = "openai"
   model: str = "tts-1"
   voice: str = "alloy"
   speed: float = 1.0
   response_format: str = "mp3"

   @model_validator(mode="after")
   def validate_provider_compatibility(self) -> "VoiceSettings":
       spec = PROVIDERS.get(self.provider)
       if not spec:
           raise ValueError(f"Unknown provider: {self.provider}. Available: {list(PROVIDERS)}")
       if self.model not in spec.models:
           raise ValueError(f"Model '{self.model}' not available for {self.provider}. Available: {list(spec.models)}")
       if self.voice not in spec.voices:
           raise ValueError(f"Voice '{self.voice}' not available for {self.provider}. Available: {list(spec.voices)}")
       if not 0.25 <= self.speed <= 4.0:
           raise ValueError("Speed must be between 0.25 and 4.0")
       return self


class AgentConfig(BaseModel):
   group: str | None = None
   provider: str | None = None
   model: str | None = None
   voice: str | None = None
   speed: float | None = None
   response_format: str | None = None


class AgentTTSConfig(BaseModel):
   defaults: VoiceSettings = VoiceSettings()
   groups: dict[str, dict[str, Any]] = {}
   agents: dict[str, AgentConfig] = {}

   @classmethod
   def from_yaml(cls, path: str | Path = "config.yaml") -> "AgentTTSConfig":
       with open(path) as f:
           return cls.model_validate(yaml.safe_load(f))