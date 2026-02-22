#!/usr/bin/env python3
"""Orchestrate full VedicVoice video production from a spec file.

Usage:
  python3 produce_video.py spec.json [--outdir ./output] [--dry-run]

spec.json format:
{
  "type": "mantra-short" | "story-short" | "deep-dive" | "bal-gita",
  "title": "Isha Upanishad 1.1",
  "scenes": [
    {
      "name": "hook",
      "duration": 5,
      "image_prompt": "...",
      "image_model": "nano-banana-pro",
      "narration": "Did you know that...",
      "narration_voice": "elevenlabs:george",
      "text_overlay": "Optional text shown on screen"
    },
    {
      "name": "sanskrit",
      "duration": 15,
      "sanskrit_text": "ईशावास्यमिदं सर्वं",
      "transliteration": "īśāvāsyam idaṁ sarvaṁ",
      "sanskrit_audio": "ai4bharat:chanting",
      "image_prompt": "..."
    }
  ],
  "cta": {
    "text": "Listen on vedicvoice.app/library",
    "handle": "@VedicVoice"
  },
  "music": "calm" | "epic" | "devotional" | null,
  "output": {
    "width": 1080,
    "height": 1920,
    "fps": 30
  }
}
"""

import argparse, json, os, sys, subprocess, shutil

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
REMOTION_DIR = "/home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/vedicvoice-videos"

def estimate_cost(spec):
    """Estimate total production cost."""
    from generate_images import MODEL_PRICES
    
    cost = 0
    details = []
    for scene in spec.get("scenes", []):
        if scene.get("image_prompt"):
            model = scene.get("image_model", "flux-2-pro")
            price = MODEL_PRICES.get(model, 0.03)
            cost += price
            details.append(f"  {scene['name']}: image ({model}) ${price:.3f}")
        
        voice = scene.get("narration_voice", "")
        if "elevenlabs" in voice:
            chars = len(scene.get("narration", ""))
            el_cost = chars * 0.00003  # ~$0.03 per 1000 chars
            cost += el_cost
            details.append(f"  {scene['name']}: narration (ElevenLabs) ${el_cost:.3f}")
    
    return cost, details

def generate_scene_images(spec, outdir):
    """Generate all scene images."""
    scenes_with_images = [s for s in spec.get("scenes", []) if s.get("image_prompt")]
    if not scenes_with_images:
        print("No images to generate.")
        return
    
    # Build batch spec
    batch = []
    for scene in scenes_with_images:
        batch.append({
            "name": scene["name"],
            "prompt": scene["image_prompt"],
            "model": scene.get("image_model", "flux-2-pro"),
            "width": spec.get("output", {}).get("width", 1080),
            "height": spec.get("output", {}).get("height", 1920),
        })
    
    batch_file = os.path.join(outdir, "_image_batch.json")
    with open(batch_file, "w") as f:
        json.dump(batch, f)
    
    img_dir = os.path.join(outdir, "images")
    os.makedirs(img_dir, exist_ok=True)
    
    subprocess.run(
        [sys.executable, os.path.join(SKILL_DIR, "generate_images.py"),
         "--spec", batch_file, "--outdir", img_dir],
        check=True
    )
    
    os.remove(batch_file)

def generate_scene_audio(spec, outdir):
    """Generate narration and Sanskrit audio for all scenes."""
    audio_dir = os.path.join(outdir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    
    audio_script = os.path.join(SKILL_DIR, "generate_audio.sh")
    
    for scene in spec.get("scenes", []):
        name = scene["name"]
        
        # English narration
        if scene.get("narration"):
            voice_spec = scene.get("narration_voice", "elevenlabs:george")
            provider, *voice_parts = voice_spec.split(":")
            voice = voice_parts[0] if voice_parts else ""
            
            out_file = os.path.join(audio_dir, f"{name}-narration.mp3")
            print(f"Generating narration: {name}...")
            
            if provider == "elevenlabs":
                voice_id_map = {
                    "george": "JBFqnCBsd6RMkjVDRZzb",
                    "nova": "",  # Look up via API
                }
                voice_id = voice_id_map.get(voice, voice)
                subprocess.run(
                    ["bash", audio_script, "elevenlabs", scene["narration"], out_file, voice_id],
                    check=True
                )
        
        # Sanskrit audio
        if scene.get("sanskrit_text") and scene.get("sanskrit_audio"):
            style_spec = scene.get("sanskrit_audio", "ai4bharat:chanting")
            provider, *style_parts = style_spec.split(":")
            style = style_parts[0] if style_parts else "chanting"
            
            out_file = os.path.join(audio_dir, f"{name}-sanskrit.wav")
            print(f"Generating Sanskrit audio: {name}...")
            
            subprocess.run(
                ["bash", audio_script, provider, scene["sanskrit_text"], out_file, style],
                check=True
            )

def copy_to_remotion(spec, outdir):
    """Copy generated assets into Remotion's public/ directory for rendering."""
    remotion_public = os.path.join(REMOTION_DIR, "public")
    
    # Copy images
    src_images = os.path.join(outdir, "images")
    dst_images = os.path.join(remotion_public, "images")
    if os.path.exists(src_images):
        os.makedirs(dst_images, exist_ok=True)
        for f in os.listdir(src_images):
            shutil.copy2(os.path.join(src_images, f), os.path.join(dst_images, f))
        print(f"Copied images to {dst_images}")
    
    # Copy audio
    src_audio = os.path.join(outdir, "audio")
    dst_audio = os.path.join(remotion_public, "audio")
    if os.path.exists(src_audio):
        os.makedirs(dst_audio, exist_ok=True)
        for f in os.listdir(src_audio):
            shutil.copy2(os.path.join(src_audio, f), os.path.join(dst_audio, f))
        print(f"Copied audio to {dst_audio}")

def render_remotion(spec, outdir, composition_id):
    """Render via Remotion CLI."""
    output_file = os.path.join(outdir, f"{spec.get('title', 'video').replace(' ', '-').lower()}.mp4")
    
    # Build props JSON
    props = {}
    for scene in spec.get("scenes", []):
        props[scene["name"]] = {
            k: v for k, v in scene.items() 
            if k not in ("image_prompt", "image_model", "narration_voice", "sanskrit_audio")
        }
    
    props_file = os.path.join(outdir, "_remotion_props.json")
    with open(props_file, "w") as f:
        json.dump(props, f)
    
    cmd = [
        "npx", "remotion", "render",
        composition_id,
        output_file,
        "--props", props_file,
    ]
    
    print(f"Rendering {composition_id} → {output_file}")
    subprocess.run(cmd, cwd=REMOTION_DIR, check=True)
    
    if os.path.exists(props_file):
        os.remove(props_file)
    
    return output_file

def main():
    parser = argparse.ArgumentParser(description="Produce VedicVoice video from spec")
    parser.add_argument("spec", help="Production spec JSON file")
    parser.add_argument("--outdir", default="./output", help="Output directory")
    parser.add_argument("--dry-run", action="store_true", help="Show cost estimate only")
    parser.add_argument("--skip-images", action="store_true", help="Skip image generation (use existing)")
    parser.add_argument("--skip-audio", action="store_true", help="Skip audio generation (use existing)")
    parser.add_argument("--skip-render", action="store_true", help="Skip Remotion render")
    parser.add_argument("--composition", help="Remotion composition ID override")
    args = parser.parse_args()
    
    with open(args.spec) as f:
        spec = json.load(f)
    
    os.makedirs(args.outdir, exist_ok=True)
    
    # Cost estimate
    cost, details = estimate_cost(spec)
    print(f"=== {spec.get('title', 'Untitled')} ===")
    print(f"Type: {spec.get('type', 'unknown')}")
    print(f"Scenes: {len(spec.get('scenes', []))}")
    print(f"Estimated cost: ${cost:.2f}")
    for d in details:
        print(d)
    
    if args.dry_run:
        return
    
    # Step 1: Generate images
    if not args.skip_images:
        print("\n--- Generating Images ---")
        generate_scene_images(spec, args.outdir)
    
    # Step 2: Generate audio
    if not args.skip_audio:
        print("\n--- Generating Audio ---")
        generate_scene_audio(spec, args.outdir)
    
    # Step 3: Copy to Remotion
    print("\n--- Copying to Remotion ---")
    copy_to_remotion(spec, args.outdir)
    
    # Step 4: Render
    if not args.skip_render:
        print("\n--- Rendering Video ---")
        comp_id = args.composition or {
            "mantra-short": "MantraShort",
            "story-short": "StoryShort",
            "bal-gita": "StoryShort",
            "deep-dive": "MantraShort",
        }.get(spec.get("type"), "StoryShort")
        
        output = render_remotion(spec, args.outdir, comp_id)
        print(f"\n✅ Done! Output: {output}")

if __name__ == "__main__":
    main()
