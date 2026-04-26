from future import annotations
import json
import click
from agent_tts.config import AgentTTSConfig
from agent_tts.providers import PROVIDERS
from agent_tts.resolver import VoiceResolver


def load(configpath: str) -> tuple[AgentTTSConfig, VoiceResolver]:
   cfg = AgentTTSConfig.from_yaml(config_path)
   return cfg, VoiceResolver(cfg)


@click.group()
@click.option("--config", "-c", default="config.yaml", help="Config file path")
@click.pass_context
def cli(ctx: click.Context, config: str) -> None:
   """Per-agent TTS voice configuration CLI."""
   ctx.ensure_object(dict)
   ctx.obj["config_path"] = config


@cli.command()
@click.argument("agent_id")
@click.pass_context
def resolve(ctx: click.Context, agent_id: str) -> None:
   """Resolve effective voice settings for an agent."""
 , resolver = load(ctx.obj["config_path"])
   settings = resolver.resolve(agent_id)
   click.echo(json.dumps(settings.model_dump(), indent=2))


@cli.command()
@click.argument("provider")
def voices(provider: str) -> None:
   """List available voices for a provider."""
   spec = PROVIDERS.get(provider)
   if not spec:
       click.echo(f"Unknown provider: {provider}. Available: {list(PROVIDERS)}")
       raise SystemExit(1)
   click.echo(f"Models: {', '.join(spec.models)}")
   click.echo(f"Voices: {', '.join(spec.voices)}")


@cli.command()
@click.pass_context
def validate(ctx: click.Context) -> None:
   """Validate all agent configurations."""
   cfg, resolver = load(ctx.obj["configpath"])
   errors: list[str] = []
   for agent_id in cfg.agents:
       try:
           resolver.resolve(agent_id)
       except Exception as e:
           errors.append(f"  {agent_id}: {e}")
   if errors:
       click.echo("Validation errors:\n" + "\n".join(errors))
       raise SystemExit(1)
   click.echo(f"All {len(cfg.agents)} agent configs valid.")


@cli.command()
@click.argument("agent_id")
@click.argument("text")
@click.option("--output", "-o", default="output.mp3", help="Output file")
@click.pass_context
def speak(ctx: click.Context, agent_id: str, text: str, output: str) -> None:
   """Synthesize speech for an agent."""
   import asyncio, os
   from agent_tts.synthesizer import TTSSynthesizer

 , resolver = load(ctx.obj["config_path"])
   settings = resolver.resolve(agent_id)
   keys = {p: os.environ.get(f"{p.upper()}_API_KEY", "") for p in PROVIDERS}
   synth = TTSSynthesizer(api_keys=keys)

   audio = asyncio.run(synth.synthesize(settings, text))
   with open(output, "wb") as f:
       f.write(audio)
   click.echo(f"Wrote {len(audio)} bytes to {output}")


@cli.command()
@click.option("--host", default="0.0.0.0", help="Bind host")
@click.option("--port", default=8000, help="Bind port")
@click.pass_context
def serve(ctx: click.Context, host: str, port: int) -> None:
   """Start the REST API server."""
   import uvicorn, os
   os.environ["AGENT_TTS_CONFIG"] = ctx.obj["config_path"]
   uvicorn.run("agent_tts.api:app", host=host, port=port)