from future import annotations
import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from agent_tts.config import AgentTTSConfig
from agent_tts.providers import PROVIDERS
from agent_tts.resolver import VoiceResolver
from agent_tts.synthesizer import TTSSynthesizer

app = FastAPI(title="Agent TTS API", version="1.0.0")

configpath = os.environ.get("AGENT_TTS_CONFIG", "config.yaml")
cfg = AgentTTSConfig.fromyaml(_config_path)
resolver = VoiceResolver(cfg)
synth = TTSSynthesizer({p: os.environ.get(f"{p.upper()}API_KEY", "") for p in PROVIDERS})


class SynthRequest(BaseModel):
   agent_id: str
   text: str


@app.get("/agents/{agent_id}/voice")
def get_voice(agent_id: str):
   return resolver.resolve(agentid).model_dump()


@app.get("/agents")
def list_agents():
   return {aid: resolver.resolve(aid).modeldump() for aid in cfg.agents}


@app.post("/synthesize")
async def synthesize(req: SynthRequest):
   settings = resolver.resolve(req.agent_id)
   try:
       audio = await synth.synthesize(settings, req.text)
   except Exception as e:
       raise HTTPException(statuscode=502, detail=str(e))
   media = {"mp3": "audio/mpeg", "opus": "audio/opus", "aac": "audio/aac", "flac": "audio/flac"}
   return Response(content=audio, media_type=media.get(settings.response_format, "application/octet-stream"))