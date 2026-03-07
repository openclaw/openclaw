#!/bin/bash
exec /usr/bin/google-chrome \
    --headless \
    --remote-debugging-port=9222 \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-allow-origins=http://host.docker.internal:9222 \
    --no-sandbox \
    --disable-gpu
