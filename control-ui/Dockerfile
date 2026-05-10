# ALPHABET CONTROL UI - Docker Build
FROM node:18-alpine

WORKDIR /app

# Copy package files first (for layer caching)
COPY package*.json ./

# Install dependencies
RUN npm install --prefer-offline --no-audit --progress=false

# Copy application source
COPY . .

# Expose Vite port
EXPOSE 5173

# Start Vite dev server
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
