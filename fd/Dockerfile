FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY packages/ ./packages/
COPY services/ ./services/
COPY db/ ./db/
COPY config/ ./config/

RUN pip install --no-cache-dir -e "."

ENV OPENCLAW_ENV=dev
ENV OPENCLAW_DB=/app/data/openclaw.db
ENV OPENCLAW_MIGRATIONS=/app/db/migrations
ENV OPENCLAW_AUTO_MIGRATE=true

EXPOSE 8080

CMD ["python", "-m", "packages.app", "--host", "0.0.0.0", "--port", "8080"]
