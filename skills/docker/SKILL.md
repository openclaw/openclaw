---
name: docker
description: Manage Docker containers, images, volumes, and networks. Use for container lifecycle (run, stop, remove), image management (build, pull, push), logs, exec into containers, and Docker Compose operations.
metadata:
  {
    "openclaw":
      {
        "emoji": "🐳",
        "requires": { "bins": ["docker"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "docker",
              "bins": ["docker"],
              "label": "Install Docker CLI (brew)",
            },
            {
              "id": "apt",
              "kind": "apt",
              "package": "docker.io",
              "bins": ["docker"],
              "label": "Install Docker (apt)",
            },
          ],
      },
  }
---

# Docker

Manage Docker containers, images, volumes, and networks via CLI.

## Containers

### List Containers

```bash
# Running containers
docker ps

# All containers (including stopped)
docker ps -a

# Compact format
docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### Run Container

```bash
# Basic run (foreground)
docker run --name myapp nginx

# Detached (background)
docker run -d --name myapp nginx

# With port mapping
docker run -d -p 8080:80 --name web nginx

# With environment variables
docker run -d -e POSTGRES_PASSWORD=secret --name db postgres

# With volume mount
docker run -d -v /host/path:/container/path --name app myimage

# With restart policy
docker run -d --restart unless-stopped --name app myimage

# Interactive shell
docker run -it --rm ubuntu bash
```

### Container Lifecycle

```bash
# Stop container
docker stop <container>

# Start stopped container
docker start <container>

# Restart container
docker restart <container>

# Remove container
docker rm <container>

# Force remove running container
docker rm -f <container>

# Remove all stopped containers
docker container prune -f
```

### Logs

```bash
# View logs
docker logs <container>

# Follow logs (live)
docker logs -f <container>

# Last N lines
docker logs --tail 100 <container>

# With timestamps
docker logs -t <container>

# Since specific time
docker logs --since 1h <container>
```

### Execute Commands

```bash
# Run command in container
docker exec <container> <command>

# Interactive shell
docker exec -it <container> bash
docker exec -it <container> sh

# As specific user
docker exec -u root -it <container> bash
```

### Inspect & Stats

```bash
# Container details
docker inspect <container>

# Resource usage
docker stats

# Specific container stats (no stream)
docker stats --no-stream <container>

# Container processes
docker top <container>
```

## Images

### List Images

```bash
# All images
docker images

# With digests
docker images --digests

# Filter dangling images
docker images -f "dangling=true"
```

### Pull & Push

```bash
# Pull image
docker pull nginx
docker pull nginx:1.25
docker pull ghcr.io/owner/image:tag

# Push image
docker push myregistry/myimage:tag
```

### Build

```bash
# Build from Dockerfile in current directory
docker build -t myimage .

# With specific Dockerfile
docker build -f Dockerfile.prod -t myimage:prod .

# With build args
docker build --build-arg VERSION=1.0 -t myimage .

# No cache
docker build --no-cache -t myimage .

# Multi-platform
docker buildx build --platform linux/amd64,linux/arm64 -t myimage .
```

### Remove Images

```bash
# Remove image
docker rmi <image>

# Force remove
docker rmi -f <image>

# Remove unused images
docker image prune -f

# Remove ALL unused images (not just dangling)
docker image prune -a -f
```

## Volumes

```bash
# List volumes
docker volume ls

# Create volume
docker volume create myvolume

# Inspect volume
docker volume inspect myvolume

# Remove volume
docker volume rm myvolume

# Remove unused volumes
docker volume prune -f
```

## Networks

```bash
# List networks
docker network ls

# Create network
docker network create mynetwork

# Connect container to network
docker network connect mynetwork <container>

# Disconnect container
docker network disconnect mynetwork <container>

# Inspect network
docker network inspect mynetwork

# Remove network
docker network rm mynetwork
```

## Docker Compose

### Basic Operations

```bash
# Start services (detached)
docker compose up -d

# Start specific service
docker compose up -d <service>

# Stop services
docker compose down

# Stop and remove volumes
docker compose down -v

# Restart services
docker compose restart

# View logs
docker compose logs
docker compose logs -f <service>
```

### Build & Pull

```bash
# Build images
docker compose build

# Build without cache
docker compose build --no-cache

# Pull images
docker compose pull
```

### Status & Exec

```bash
# List containers
docker compose ps

# Execute command
docker compose exec <service> <command>

# Interactive shell
docker compose exec <service> bash
```

## System

```bash
# Disk usage
docker system df

# Detailed disk usage
docker system df -v

# Clean up everything (containers, images, volumes, networks)
docker system prune -a -f

# Clean up with volumes
docker system prune -a --volumes -f

# Docker info
docker info

# Docker version
docker version
```

## Common Patterns

### Quick Debug Container

```bash
# Ubuntu with common tools
docker run -it --rm ubuntu bash

# Alpine (smaller)
docker run -it --rm alpine sh

# With network tools
docker run -it --rm nicolaka/netshoot
```

### Copy Files

```bash
# Copy from container to host
docker cp <container>:/path/to/file ./local/path

# Copy from host to container
docker cp ./local/file <container>:/path/in/container
```

### Save & Load Images

```bash
# Save image to tar
docker save -o myimage.tar myimage:tag

# Load image from tar
docker load -i myimage.tar
```

## Resources

- [Docker CLI Reference](https://docs.docker.com/engine/reference/commandline/cli/)
- [Dockerfile Reference](https://docs.docker.com/engine/reference/builder/)
- [Docker Compose Reference](https://docs.docker.com/compose/compose-file/)
