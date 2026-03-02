from __future__ import annotations

from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise RuntimeError(f"Pattern not found in {path}: {old[:80]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_between(path: Path, start_marker: str, end_marker: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"Start marker not found in {path}: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"End marker not found in {path}: {end_marker!r}")
    path.write_text(text[:start] + replacement + text[end:], encoding="utf-8")


def patch_models(models: Path) -> None:
    replace_once(
        models,
        '    model_size: Optional[str] = Field(default="1.7B", pattern="^(1\\\\.7B|0\\\\.6B)$")\n'
        '    instruct: Optional[str] = Field(None, max_length=500)\n',
        '    model_size: Optional[str] = Field(default="1.7B", pattern="^(1\\\\.7B|0\\\\.6B)$")\n'
        '    max_new_tokens: Optional[int] = Field(default=384, ge=64, le=1024)\n'
        '    instruct: Optional[str] = Field(None, max_length=500)\n',
    )


def patch_main(main_py: Path) -> None:
    replacement = '''        # Create voice prompt from profile
        force_openai = os.getenv("OPENCLAW_VOICEBOX_FORCE_OPENAI", "0").strip() == "1"

        if force_openai:
            openai_key = os.getenv("OPENAI_API_KEY", "").strip()
            import io
            import subprocess
            import numpy as np
            import httpx
            import soundfile as sf

            raw_audio = None
            if openai_key:
                _OPENAI_VOICES = {"alloy","ash","coral","echo","fable","nova","onyx","sage","shimmer"}
                _env_voice = os.getenv("OPENCLAW_VOICEBOX_OPENAI_VOICE", "nova").strip() or "nova"
                # Use profile name as voice if it matches a valid OpenAI voice name
                try:
                    from backend.database import VoiceProfile as _VoiceProfile
                    _prof = db.query(_VoiceProfile).filter(
                        _VoiceProfile.id == data.profile_id
                    ).first()
                    _prof_name = (_prof.name.strip().lower() if _prof and _prof.name else "")
                    preferred_voice = _prof_name if _prof_name in _OPENAI_VOICES else _env_voice
                except Exception:
                    preferred_voice = _env_voice
                model_name = os.getenv("OPENCLAW_VOICEBOX_OPENAI_MODEL", "gpt-4o-mini-tts").strip() or "gpt-4o-mini-tts"
                payload = {
                    "model": model_name,
                    "voice": preferred_voice,
                    "input": data.text,
                    "format": "wav",
                }
                headers = {
                    "Authorization": f"Bearer {openai_key}",
                    "Content-Type": "application/json",
                }
                try:
                    async with httpx.AsyncClient(timeout=120.0) as client:
                        response = await client.post(
                            "https://api.openai.com/v1/audio/speech",
                            headers=headers,
                            json=payload,
                        )
                        response.raise_for_status()
                        raw_audio = response.content
                except Exception:
                    raw_audio = None

            if raw_audio is None:
                fallback_path = config.get_generations_dir() / f"{generation_id}-espeak.wav"
                subprocess.run(["espeak-ng", "-w", str(fallback_path), data.text], check=True)
                audio, sample_rate = sf.read(str(fallback_path), dtype="float32")
                if fallback_path.exists():
                    fallback_path.unlink()
            else:
                audio, sample_rate = sf.read(io.BytesIO(raw_audio), dtype="float32")
            if isinstance(audio, np.ndarray) and audio.ndim > 1:
                audio = np.mean(audio, axis=1)
        else:
            voice_prompt = await profiles.create_voice_prompt_for_profile(
                data.profile_id,
                db,
            )

            # Generate audio
            tts_model = await tts.get_tts_model_async()
            # Load the requested model size if different from current (async to not block)
            model_size = data.model_size or "0.6B"

            # Check if model needs to be downloaded first
            model_path = tts_model._get_model_path(model_size)
            if model_path.startswith("Qwen/"):
                # Model not cached - check if it exists remotely or needs download
                from huggingface_hub import constants as hf_constants
                repo_cache = Path(hf_constants.HF_HUB_CACHE) / ("models--" + model_path.replace("/", "--"))
                if not repo_cache.exists():
                    # Start download in background
                    model_name = f"qwen-tts-{model_size}"

                    async def download_model_background():
                        try:
                            await tts_model.load_model_async(model_size)
                        except Exception as e:
                            task_manager.error_download(model_name, str(e))

                    task_manager.start_download(model_name)
                    asyncio.create_task(download_model_background())

                    # Return 202 Accepted with download info
                    raise HTTPException(
                        status_code=202,
                        detail={
                            "message": f"Model {model_size} is being downloaded. Please wait and try again.",
                            "model_name": model_name,
                            "downloading": True,
                        },
                    )

            await tts_model.load_model_async(model_size)
            audio, sample_rate = await tts_model.generate(
                data.text,
                voice_prompt,
                data.language,
                data.seed,
                data.instruct,
                data.max_new_tokens,
            )

'''
    replace_between(
        main_py,
        "        # Create voice prompt from profile\n",
        "        # Calculate duration\n",
        replacement,
    )


def patch_bundled_and_pytorch(bundled: Path, pytorch: Path) -> None:
    replace_once(
        bundled,
        '    async def generate(\n'
        '        self,\n'
        '        text: str,\n'
        '        voice_prompt: dict,\n'
        '        language: str = "en",\n'
        '        seed: Optional[int] = None,\n'
        '        instruct: Optional[str] = None,\n'
        '    ) -> Tuple[np.ndarray, int]:\n'
        '        """Generate speech audio."""\n'
        '        backend = self._get_backend()\n'
        '        return await backend.generate(text, voice_prompt, language, seed, instruct)\n',
        '    async def generate(\n'
        '        self,\n'
        '        text: str,\n'
        '        voice_prompt: dict,\n'
        '        language: str = "en",\n'
        '        seed: Optional[int] = None,\n'
        '        instruct: Optional[str] = None,\n'
        '        max_new_tokens: Optional[int] = None,\n'
        '    ) -> Tuple[np.ndarray, int]:\n'
        '        """Generate speech audio."""\n'
        '        backend = self._get_backend()\n'
        '        return await backend.generate(\n'
        '            text,\n'
        '            voice_prompt,\n'
        '            language,\n'
        '            seed,\n'
        '            instruct,\n'
        '            max_new_tokens,\n'
        '        )\n',
    )

    replace_once(
        pytorch,
        '                self.model = Qwen3TTSModel.from_pretrained(\n'
        '                    model_path,\n'
        '                    device_map=self.device,\n'
        '                    torch_dtype=torch.float32 if self.device == "cpu" else torch.bfloat16,\n'
        '                )\n',
        '                self.model = Qwen3TTSModel.from_pretrained(\n'
        '                    model_path,\n'
        '                    device_map=self.device,\n'
        '                    dtype=torch.float32 if self.device == "cpu" else torch.bfloat16,\n'
        '                    low_cpu_mem_usage=self.device != "cpu",\n'
        '                )\n',
    )

    # x_vector_only_mode stays False (upstream default) — full voice cloning path needed
    # for voice profiles to sound distinct; True would collapse all voices to the same embedding

    replace_once(
        pytorch,
        '    async def generate(\n'
        '        self,\n'
        '        text: str,\n'
        '        voice_prompt: dict,\n'
        '        language: str = "en",\n'
        '        seed: Optional[int] = None,\n'
        '        instruct: Optional[str] = None,\n'
        '    ) -> Tuple[np.ndarray, int]:\n',
        '    async def generate(\n'
        '        self,\n'
        '        text: str,\n'
        '        voice_prompt: dict,\n'
        '        language: str = "en",\n'
        '        seed: Optional[int] = None,\n'
        '        instruct: Optional[str] = None,\n'
        '        max_new_tokens: Optional[int] = None,\n'
        '    ) -> Tuple[np.ndarray, int]:\n',
    )

    replace_once(
        pytorch,
        '            wavs, sample_rate = self.model.generate_voice_clone(\n'
        '                text=text,\n'
        '                voice_clone_prompt=voice_prompt,\n'
        '                instruct=instruct,\n'
        '            )\n',
        '            wavs, sample_rate = self.model.generate_voice_clone(\n'
        '                text=text,\n'
        '                voice_clone_prompt=voice_prompt,\n'
        '                instruct=instruct,\n'
        '                max_new_tokens=max_new_tokens or 384,\n'
        '                do_sample=True,\n'
        '                top_k=50,\n'
        '                top_p=0.95,\n'
        '                temperature=0.8,\n'
        '            )\n',
    )


def main() -> None:
    patch_models(Path("/app/backend/models.py"))
    patch_main(Path("/app/backend/main.py"))
    patch_bundled_and_pytorch(
        Path("/app/backend/providers/bundled.py"),
        Path("/app/backend/backends/pytorch_backend.py"),
    )


if __name__ == "__main__":
    main()
