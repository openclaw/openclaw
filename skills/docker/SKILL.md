---
name: docker
description: Manage Docker containers, images, and services using the `docker` CLI. Use when a user asks to list running containers, pull images, check logs, or manage docker-compose stacks.
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
              "label": "Install Docker via Homebrew",
            },
            {
              "id": "apt",
              "kind": "apt",
              "package": "docker.io",
              "bins": ["docker"],
              "label": "Install Docker via apt (Linux)",
            },
          ],
      },
  }
---

# Docker Skill

Use the `docker` CLI to manage containers and images.

## Containers

List all running containers:
```bash
docker ps
```

List all containers (including stopped ones):
```bash
docker ps -a
```

Start or Stop a container:
```bash
docker start <container_id>
docker stop <container_id>
```

View logs for a container:
```bash
docker logs -f --tail 100 <container_id>
```

## Images

List available images:
```bash
docker images
```

Pull an image from Docker Hub:
```bash
docker pull <image_name>:<tag>
```

## Docker Compose

If `docker-compose` or `docker compose` is available, manage multi-container apps:

```bash
docker compose up -d
docker compose down
```

## Performance & Cleanup

Check resource usage:
```bash
docker stats --no-stream
```

Remove unused data (prune):
```bash
docker system prune -f
```
