# Lemonade Provider Plugin

This plugin provides integration with Lemonade, which uses the Ollama-compatible API on localhost:13305 by default.

## Configuration

The Lemonade provider can be configured through environment variables or the OpenClaw configuration:

- `LEMONADE_API_KEY`: Set to any value (e.g., "lemonade-local") to enable the provider
- Base URL: Defaults to `http://127.0.0.1:13305`

## Usage

1. Start Lemonade on your local machine
2. Set `LEMONADE_API_KEY=lemonade-local` or run `openclaw configure`
3. Models will be automatically discovered from your Lemonade instance

## API Compatibility

Lemonade uses the same API as Ollama, so all Ollama-compatible features are supported.
