[project]
name = "my-api"
version = "0.1.0"
description = "FastAPI server"
readme = "README.md"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.110.0",
  "httpx>=0.27.0",
  "uvicorn[standard]>=0.29.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/local_places"]

[tool.pytest.ini_options]
addopts = "-q"
testpaths = ["tests"]
