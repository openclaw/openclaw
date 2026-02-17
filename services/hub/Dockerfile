# Stage 1: Build admin dashboard
FROM node:22-alpine AS admin-builder
WORKDIR /app/admin
COPY admin/package.json admin/package-lock.json* ./
RUN npm install
COPY admin/ .
RUN npm run build

# Stage 2: Build backend
FROM node:22-alpine AS backend-builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Stage 3: Final image (production deps only)
FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY --from=backend-builder /app/dist ./dist
COPY --from=admin-builder /app/admin/dist ./admin/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 9876
CMD ["node", "dist/index.js"]
