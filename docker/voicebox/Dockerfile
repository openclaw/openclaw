FROM ghcr.io/jamiepine/voicebox:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends sox espeak-ng \
  && rm -rf /var/lib/apt/lists/* \
  && python -m pip install --no-cache-dir "qwen-tts==0.1.1"

COPY docker/voicebox/patch_voicebox_runtime.py /tmp/patch_voicebox_runtime.py
RUN python /tmp/patch_voicebox_runtime.py && rm -f /tmp/patch_voicebox_runtime.py
