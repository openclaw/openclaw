#!/usr/bin/env python3
"""Produce a Bal Gita video for a given verse.

Usage:
  python3 produce_bal_gita.py --chapter 2 --verse 47 [--outdir /mnt/data-drive/projects/bal-gita] [--dry-run]
  python3 produce_bal_gita.py --next  # Produce the next verse without a video
  python3 produce_bal_gita.py --list  # List all verses and their video status

Requires: WAVESPEED_API_KEY in env or .env, ELEVENLABS_API_KEY in TOOLS.md
Output: Video file + YouTube/Instagram metadata JSON
"""

import argparse, json, os, sys, subprocess, time

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = "/home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/backend"
MEDIA_BASE = "https://jvrukkxdbpssxgnrttjy.supabase.co/storage/v1/object/public/media"
SUPABASE_URL = "https://jvrukkxdbpssxgnrttjy.supabase.co"

def get_supabase_key():
    """Read service key from backend .env"""
    env_file = os.path.join(BACKEND_DIR, ".env")
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                if line.startswith("SUPABASE_SERVICE_KEY="):
                    return line.strip().split("=", 1)[1].strip('"').strip("'")
    return None

def run_prisma_query(script):
    """Run a TypeScript snippet via npx tsx in the backend dir."""
    result = subprocess.run(
        ["npx", "tsx", "-e", script],
        cwd=BACKEND_DIR, capture_output=True, text=True, timeout=30
    )
    return result.stdout.strip()

def list_verses():
    """List all Bal Gita verses and their video status."""
    script = """
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const verses = await p.balGitaContent.findMany({
    include: { Verse: true },
  });
  const result = verses.map(v => ({
    id: v.id,
    chapter: v.Verse?.chapterNumber,
    verse: v.Verse?.verseNumber,
    hasVideo: !!v.videoUrl,
    sanskrit: v.Verse?.textSanskrit?.substring(0, 60),
    translation: v.Verse?.translation?.substring(0, 80),
    meaning5to7: v.meaning5to7?.substring(0, 80),
    storyContext: v.storyContext?.substring(0, 80),
  }));
  console.log(JSON.stringify(result));
  await p.$disconnect();
})();
"""
    output = run_prisma_query(script)
    # Find the JSON line
    for line in output.split('\n'):
        line = line.strip()
        if line.startswith('['):
            return json.loads(line)
    return []

def get_next_verse():
    """Get the next verse without a video."""
    verses = list_verses()
    for v in sorted(verses, key=lambda x: (x['chapter'] or 99, x['verse'] or 99)):
        if not v['hasVideo']:
            return v
    return None

def get_verse(chapter, verse_num):
    """Get a specific verse."""
    verses = list_verses()
    for v in verses:
        if v['chapter'] == chapter and v['verse'] == verse_num:
            return v
    return None

def generate_scene_plan(verse_data):
    """Generate a production scene plan for a verse.
    
    This creates the JSON spec that the agent should review/customize
    before generating. Returns a template that needs creative input.
    """
    ch = verse_data['chapter']
    vn = verse_data['verse']
    sanskrit = verse_data.get('sanskrit', '')
    translation = verse_data.get('translation', '') or verse_data.get('meaning5to7', '')
    story = verse_data.get('storyContext', '')
    
    return {
        "verse": f"BG {ch}.{vn}",
        "chapter": ch,
        "verse_number": vn,
        "sanskrit": sanskrit,
        "translation": translation,
        "story_context": story,
        "bal_gita_id": verse_data['id'],
        "scenes": [
            {
                "name": "hook",
                "duration": 5,
                "narration": "TO_BE_WRITTEN: Hook question that relates to kids' daily life",
                "image_prompt": "TO_BE_WRITTEN: Pixar-style kid scene relating to the hook",
                "image_model": "flux-2-pro"
            },
            {
                "name": "setup",
                "duration": 15,
                "narration": f"TO_BE_WRITTEN: Story setup from Mahabharata context. Context: {story[:200] if story else 'needs research'}",
                "image_prompt": "TO_BE_WRITTEN: Pixar-style Arjuna/Krishna battlefield scene",
                "image_model": "flux-2-pro"
            },
            {
                "name": "krishna_teaches",
                "duration": 19,
                "narration": f"TO_BE_WRITTEN: Krishna explains the verse in kid-friendly language. Translation: {translation[:200] if translation else 'needs research'}",
                "image_prompt": "Blue-skinned young Krishna with peacock feather crown, smiling warmly and gesturing wisely to young Arjuna, both on a golden chariot, magical sparkles and divine glow, Pixar-style 3D Indian mythology, child-friendly warm colors, vertical format, no text no watermarks",
                "image_model": "flux-2-pro"
            },
            {
                "name": "sanskrit_verse",
                "duration": 11,
                "sanskrit_text": sanskrit.split('।')[0].strip() if '।' in sanskrit else sanskrit[:50],
                "transliteration": "TO_BE_GENERATED",
                "narration_type": "verse_chanting",
                "image_prompt": "Deep cosmic blue background with golden lotus and Om motifs, sacred spiritual atmosphere, gold particles, vertical format, no text no watermarks",
                "image_model": "flux-2-pro"
            },
            {
                "name": "modern_lesson",
                "duration": 10,
                "narration": "TO_BE_WRITTEN: Modern application for kids (school, sports, friends)",
                "image_prompt": "TO_BE_WRITTEN: Happy Indian kids in a relatable modern scene, Pixar-style 3D, bright warm colors, vertical format, no text no watermarks",
                "image_model": "flux-2-pro"
            },
            {
                "name": "cta",
                "duration": 5,
                "image_prompt": None,
                "use_standard_cta": True
            }
        ],
        "youtube": {
            "title": f"TO_BE_WRITTEN: Catchy title for BG {ch}.{vn}",
            "description": f"TO_BE_WRITTEN: YouTube description with verse, translation, and VedicVoice link",
            "tags": ["bhagavad gita", "bal gita", "kids", "krishna", "sanskrit", "indian mythology", "spiritual education"],
            "category": "Education"
        },
        "instagram": {
            "caption": f"TO_BE_WRITTEN: Instagram caption with emojis, hashtags",
            "hashtags": "#BhagavadGita #BalGita #Krishna #SanskritForKids #IndianMythology #VedicVoice #SpiritualKids #Mahabharata #HinduMythology #KidsEducation"
        }
    }

def generate_social_metadata(verse_data, episode_num):
    """Generate YouTube and Instagram metadata for a verse."""
    ch = verse_data['chapter']
    vn = verse_data['verse']
    translation = verse_data.get('translation', '') or verse_data.get('meaning5to7', '')
    
    return {
        "episode": episode_num,
        "verse_ref": f"BG {ch}.{vn}",
        "youtube": {
            "title_template": f"Bal Gita Ep {episode_num}: {{catchy_title}} | Bhagavad Gita {ch}.{vn} for Kids",
            "description_template": f"""🙏 Bal Gita Episode {episode_num} — Bhagavad Gita Chapter {ch}, Verse {vn}

{{verse_summary}}

Sanskrit:
{{sanskrit_text}}

Translation:
{{translation}}

🎬 Watch all Bal Gita episodes: https://vedicvoice.app/bal-gita
📚 Read the full Bhagavad Gita: https://vedicvoice.app/gita

VedicVoice — Making ancient Sanskrit wisdom accessible to everyone.

#BhagavadGita #BalGita #Krishna #SanskritForKids""",
            "tags": [
                "bhagavad gita for kids", "bal gita", "krishna teaches arjuna",
                f"bhagavad gita chapter {ch}", f"bg {ch}.{vn}", "sanskrit for children",
                "indian mythology for kids", "vedicvoice", "spiritual education",
                "pixar style animation", "hindu stories for kids"
            ]
        },
        "instagram": {
            "caption_template": f"""🎬 Bal Gita Ep {episode_num} — BG {ch}.{vn}

{{hook_question}}

{{kid_friendly_lesson}}

Sanskrit: {{first_line_sanskrit}}

✨ Watch the full video (link in bio)

#BhagavadGita #BalGita #Krishna #SanskritForKids #IndianMythology #VedicVoice #SpiritualKids #Mahabharata #KidsEducation #HinduStories #AncientWisdom #Reels""",
            "reel_format": "9:16 vertical, 60 seconds"
        }
    }

def main():
    parser = argparse.ArgumentParser(description="Produce Bal Gita videos")
    parser.add_argument("--list", action="store_true", help="List all verses and status")
    parser.add_argument("--next", action="store_true", help="Get next verse without video")
    parser.add_argument("--chapter", "-c", type=int, help="Chapter number")
    parser.add_argument("--verse", "-v", type=int, help="Verse number")
    parser.add_argument("--outdir", default="/mnt/data-drive/projects/bal-gita", help="Output directory")
    parser.add_argument("--plan-only", action="store_true", help="Generate scene plan JSON only")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    args = parser.parse_args()
    
    if args.list:
        verses = list_verses()
        total = len(verses)
        with_video = sum(1 for v in verses if v['hasVideo'])
        print(f"Bal Gita Verses: {total} total, {with_video} with video, {total - with_video} remaining\n")
        
        current_ch = None
        for v in sorted(verses, key=lambda x: (x['chapter'] or 99, x['verse'] or 99)):
            if v['chapter'] != current_ch:
                current_ch = v['chapter']
                print(f"\n--- Chapter {current_ch} ---")
            status = "✅" if v['hasVideo'] else "⬜"
            print(f"  {status} {v['chapter']}.{v['verse']:>2}  {v.get('sanskrit','')[:50]}")
        return
    
    if args.next:
        verse = get_next_verse()
        if not verse:
            print("All verses have videos!")
            return
        print(f"Next: BG {verse['chapter']}.{verse['verse']}")
        print(json.dumps(verse, indent=2, ensure_ascii=False))
        return
    
    if args.chapter and args.verse:
        verse = get_verse(args.chapter, args.verse)
        if not verse:
            print(f"Verse BG {args.chapter}.{args.verse} not found in Bal Gita")
            return
    elif not args.plan_only:
        parser.print_help()
        return
    
    # Generate scene plan
    if args.plan_only or args.dry_run:
        plan = generate_scene_plan(verse)
        metadata = generate_social_metadata(verse, "X")
        
        outdir = os.path.join(args.outdir, f"ch{verse['chapter']}-v{verse['verse']}")
        os.makedirs(outdir, exist_ok=True)
        
        plan_file = os.path.join(outdir, "scene_plan.json")
        with open(plan_file, "w") as f:
            json.dump(plan, f, indent=2, ensure_ascii=False)
        print(f"Scene plan: {plan_file}")
        
        meta_file = os.path.join(outdir, "social_metadata.json")
        with open(meta_file, "w") as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
        print(f"Social metadata: {meta_file}")
        
        print(f"\nVerse: BG {verse['chapter']}.{verse['verse']}")
        print(f"Sanskrit: {verse.get('sanskrit','')[:80]}")
        print(f"Translation: {verse.get('translation','')[:80]}")
        print(f"\nScene plan has {len(plan['scenes'])} scenes with TO_BE_WRITTEN placeholders.")
        print("Agent should fill in narration, image prompts, and social copy before production.")
        return

if __name__ == "__main__":
    main()
