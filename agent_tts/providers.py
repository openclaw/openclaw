from dataclasses import dataclass

@dataclass(frozen=True)
class ProviderSpec:
   models: tuple[str, ...]
   voices: tuple[str, ...]

PROVIDERS: dict[str, ProviderSpec] = {
   "openai": ProviderSpec(
       models=("tts-1", "tts-1-hd"),
       voices=("alloy", "echo", "fable", "onyx", "nova", "shimmer"),
   ),
   "elevenlabs": ProviderSpec(
       models=("eleven_multilingual_v2", "eleven_turbo_v2"),
       voices=("rachel", "adam", "antoni", "bella", "domi", "elli", "josh", "sam"),
   ),
   "google": ProviderSpec(
       models=("standard", "wavenet", "neural2"),
       voices=tuple(
           f"en-US-{t}-{c}"
           for t in ("Standard", "Wavenet", "Neural2")
           for c in "ABCDEFGHIJ"
       ),
   ),
}