FROM python:3.10-slim

WORKDIR /app

# Install edge-tts and uvicorn for ASGI server
RUN pip install --no-cache-dir \
    edge-tts \
    fastapi \
    uvicorn[standard] \
    aiofiles

# Create app directory
RUN mkdir -p /app/audio

COPY server.py /app/server.py

EXPOSE 10802

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "10802"]
