"""
Edge TTS API Server for OpenClaw Android
Simple text-to-speech using Microsoft Edge's TTS service
"""
import os
import tempfile
import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import io

app = FastAPI(title="Edge TTS Service")

# Default voice (English female)
DEFAULT_VOICE = "en-US-JennyNeural"

# Chinese voice options
CHINESE_VOICES = {
    "zh-CN-XiaoxiaoNeural": "Chinese (Mainland) - Female, Warm",
    "zh-CN-YunxiNeural": "Chinese (Mainland) - Male, Relaxed",
    "zh-CN-YunjianNeural": "Chinese (Mainland) - Male, Sports",
    "zh-CN-XiaoyiNeural": "Chinese (Mainland) - Female, Cute",
    "zh-HK-HiuMaanNeural": "Chinese (Cantonese) - Female",
    "zh-TW-HsiaoChenNeural": "Chinese (Taiwan) - Female",
}

# English voice options
ENGLISH_VOICES = {
    "en-US-JennyNeural": "English (US) - Female",
    "en-US-GuyNeural": "English (US) - Male",
    "en-US-AriaNeural": "English (US) - Female, Cheerful",
    "en-GB-SoniaNeural": "English (UK) - Female",
    "en-GB-RyanNeural": "English (UK) - Male",
}


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    rate: str = "+0%"
    pitch: str = "+0Hz"


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "edge-tts"}


@app.get("/voices")
async def list_voices():
    """List available voices"""
    return {
        "chinese": CHINESE_VOICES,
        "english": ENGLISH_VOICES,
        "default": DEFAULT_VOICE
    }


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    """
    Synthesize speech from text
    Returns audio file (mp3 format)
    """
    try:
        # Create temporary file for output
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            output_file = f.name

        # Use edge-tts to generate speech
        communicate = edge_tts.Communicate(
            text=request.text,
            voice=request.voice,
            rate=request.rate,
            pitch=request.pitch
        )

        await communicate.save(output_file)

        # Return audio file
        return FileResponse(
            output_file,
            media_type="audio/mpeg",
            headers={"Content-Disposition": "attachment; filename=speech.mp3"}
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/synthesize/stream")
async def synthesize_stream(text: str, voice: str = DEFAULT_VOICE):
    """
    Synthesize speech and return as streaming response
    """
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            output_file = f.name

        communicate = edge_tts.Communicate(text=text, voice=voice)
        await communicate.save(output_file)

        def iterfile():
            with open(output_file, 'rb') as f:
                yield from f
            os.unlink(output_file)

        return StreamingResponse(
            iterfile(),
            media_type="audio/mpeg",
            headers={"Content-Disposition": "attachment; filename=speech.mp3"}
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=10802)
