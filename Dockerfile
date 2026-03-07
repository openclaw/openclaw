FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Copy project files
COPY pyproject.toml ./
COPY engine ./engine
COPY agents ./agents
COPY sdk ./sdk
COPY cli ./cli
COPY config ./config

# Install Python dependencies
RUN pip install --no-cache-dir -e .

# Create necessary directories
RUN mkdir -p /app/logs /app/data

# Expose port
EXPOSE 8000

# Run the application
CMD ["uvicorn", "engine.core.app:app", "--host", "0.0.0.0", "--port", "8000"]
