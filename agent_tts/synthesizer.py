from future import annotations
import httpx
from agent_tts.config import VoiceSettings


class TTSSynthesizer:
   """Provider-aware TTS synthesis client."""

   def init(self, api_keys: dict[str, str] | None = None):
       self._keys = api_keys or {}

   async def synthesize(self, settings: VoiceSettings, text: str) -> bytes:
       handler = getattr(self, f"_synth_{settings.provider}", None)
       if not handler:
           raise NotImplementedError(f"Synthesis not implemented for {settings.provider}")
       return await handler(settings, text)

   async def synthopenai(self, s: VoiceSettings, text: str) -> bytes:
       async with httpx.AsyncClient() as client:
           resp = await client.post(
               "https://api.openai.com/v1/audio/speech",
               headers={"Authorization": f"Bearer {self._keys.get('openai', '')}"},
               json={"model": s.model, "voice": s.voice, "input": text, "speed": s.speed, "response_format": s.response_format},
               timeout=30.0,
           )
           resp.raise_for_status()
           return resp.content

   async def synthelevenlabs(self, s: VoiceSettings, text: str) -> bytes:
       async with httpx.AsyncClient() as client:
           resp = await client.post(
               f"https://api.elevenlabs.io/v1/text-to-speech/{s.voice}",
               headers={"xi-api-key": self._keys.get("elevenlabs", "")},
               json={"text": text, "model_id": s.model},
               timeout=30.0,
           )
           resp.raise_for_status()
           return resp.content