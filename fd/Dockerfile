FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# Docker context must be the repo root (parent of fd/).
# Build: docker build -f fd/Dockerfile .   (from repo root)
# Or:    docker build -f Dockerfile ..     (from fd/)
COPY fd/pyproject.toml ./
COPY fd/packages/ ./packages/
COPY fd/services/ ./services/
COPY fd/db/ ./db/
COPY config/fd/ ./config/

RUN pip install --no-cache-dir -e "."

ENV OPENCLAW_ENV=dev
ENV OPENCLAW_DB=/app/data/openclaw.db
ENV OPENCLAW_MIGRATIONS=/app/db/migrations
ENV OPENCLAW_AUTO_MIGRATE=true

EXPOSE 8080

CMD ["python", "-m", "packages.app", "--host", "0.0.0.0", "--port", "8080"]
