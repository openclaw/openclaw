import sys
content = open('CHANGELOG.md').read()
old = """<<<<<<< HEAD
- TTS: add Resemble AI as a TTS provider with voice cloning support.
- Docs: seed zh-CN translations. (#6619) Thanks @joshp123.
- Docs: expand zh-Hans navigation and fix zh-CN index asset paths. (#7242) Thanks @joshp123.
- Docs: add zh-CN landing notice + AI-translated image. (#7303) Thanks @joshp123.
=======
- Feishu: add Feishu/Lark plugin support + docs. (#7313) Thanks @jiulingyun (openclaw-cn).
- Web UI: add Agents dashboard for managing agent files, tools, skills, models, channels, and cron jobs.
- Subagents: discourage direct messaging tool use unless a specific external recipient is requested.
- Memory: implement the opt-in QMD backend for workspace memory. (#3160) Thanks @vignesh07.
- Security: add healthcheck skill and bootstrap audit guidance. (#7641) Thanks @Takhoffman.
>>>>>>> origin/main"""
new = """- TTS: add Resemble AI as a TTS provider with voice cloning support.
- Feishu: add Feishu/Lark plugin support + docs. (#7313) Thanks @jiulingyun (openclaw-cn).
- Web UI: add Agents dashboard for managing agent files, tools, skills, models, channels, and cron jobs.
- Subagents: discourage direct messaging tool use unless a specific external recipient is requested.
- Memory: implement the opt-in QMD backend for workspace memory. (#3160) Thanks @vignesh07.
- Security: add healthcheck skill and bootstrap audit guidance. (#7641) Thanks @Takhoffman."""

if old in content:
    with open('CHANGELOG.md', 'w') as f:
        f.write(content.replace(old, new))
    print("CHANGELOG fixed")
else:
    print("Not found")
