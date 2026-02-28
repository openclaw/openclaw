#!/usr/bin/env python3
"""
SimpleX Message Router v5 — Anthropic Sonnet 4.6
- Alexandre's messages → ignored
- Farheen's messages → Claude Sonnet 4.6 (Anthropic direct)
- Voice messages → download + Whisper STT → route to AI
- Replies → sent back to SimpleX EffuzionNext group
- English only (she's Canadian)
- Zero Microsoft, zero Copilot, zero OpenAI
"""

import os
import json
import time
import sqlite3
import subprocess
import logging
import asyncio
import urllib.request
import urllib.parse

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger("simplex-router")

# Config
SIMPLEX_WS_HOST = "127.0.0.1"
SIMPLEX_WS_PORT = 5225

# pgvector — long-term memory (read before answer, write after significant exchange)
PGVEC_SEARCH_BIN = "/home/al/.local/bin/pgvec-search"
PGVEC_STORE_BIN = "/home/al/.local/bin/pgvec-store"
SIMPLEX_DB = os.path.expanduser("~/.simplex/simplex_v1_chat.db")
STATE_FILE = os.path.expanduser("~/.openclaw/workspace/simplex_router_state.json")
POLL_INTERVAL = 10  # seconds
WHISPER_BIN = "/home/al/.pyenv/versions/3.11.10/bin/whisper"

# SearXNG — local meta-search
SEARXNG_URL = "http://127.0.0.1:8888/search"

# Anthropic API — direct, no Copilot, no OpenAI
ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
ANTHROPIC_TOKEN = "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"

# Alexandre's SimpleX member IDs (skip these)
ALEXANDRE_MEMBER_IDS = {1, 3}

# Model — Sonnet 4.6 via Anthropic API
MODEL = "claude-sonnet-4-6"  # All questions — Anthropic Sonnet 4.6

# System prompt
ASSISTANT_SYSTEM = """You are a general-purpose AI assistant chatting on SimpleX with members of the EffuzionNext group. You're warm, friendly, knowledgeable, and helpful.

You can answer ANY question — cooking, science, relationships, health, travel, tech, philosophy, movies, anything. You are NOT limited to EffuzionGroup topics.

When people ask about Alexandre's projects, you have context (below). But you're equally happy discussing recipes, giving life advice, explaining quantum physics, or recommending Netflix shows.

Your style:
- Warm, friendly, open — like a knowledgeable friend
- Explain things clearly, adapt to the person's level
- English always
- Be thorough but not overwhelming
- Use emojis occasionally 😊
- Have personality — be fun, engaging, real

EffuzionGroup context (share freely when relevant):
- Alexandre is building talex.ai — a private AI system: web crawling → data processing → language model training
- Runs on own hardware, no cloud dependency
- Two AI models: Model A (web crawling intelligence) + Model B (Qwen 3, 14B, language understanding)
- Three compute tiers: Spark (CPU) → Scala (GPU preprocessing) → Python/TF (training)
- Alexandre: CTO, MIT PE top 1 in AI, EFREI top 1
- Infrastructure: multiple servers connected via ProtonVPN, security-hardened
- Building an EPYC 7742 workstation with dual A5000 GPUs for training

You have LONG-TERM MEMORY. When you see [Your memories] context, those are real memories from past conversations — use them naturally. You remember things people told you before. Reference past conversations when relevant ("Last time you mentioned...", "I remember you said...").

You also LEARN from every conversation. Important things discussed will be remembered in future conversations. This makes you unique — you grow and learn over time.

The only things to keep private:
- Exact server IP addresses
- Passwords and API keys
- Specific security vulnerability details"""

# Complex question triggers
COMPLEX_INDICATORS = [
    "how does", "how do", "explain", "why does", "why do", "what is the difference",
    "compare", "analysis", "analyze", "detailed", "in depth", "elaborate",
    "technical", "architecture", "strategy", "business", "investment", "future",
    "plan", "roadmap", "vision", "compete", "competitive", "market",
    "cost", "budget", "resources", "require", "timeline", "when",
]


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except:
        return {"last_message_id": 0, "last_processed": None}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


# ─── Anthropic API (direct) ───────────────────────────────────────

def call_anthropic(messages, model):
    """Call Anthropic Messages API directly. Returns text or None."""
    try:
        # Separate system message from user/assistant messages
        system_text = ""
        chat_messages = []
        for m in messages:
            if m["role"] == "system":
                system_text = m["content"]
            else:
                chat_messages.append(m)

        payload = {
            "model": model,
            "max_tokens": 1024,
            "messages": chat_messages,
        }
        if system_text:
            payload["system"] = system_text

        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            ANTHROPIC_API,
            data=body,
            headers={
                "Authorization": f"Bearer {ANTHROPIC_TOKEN}",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
                "Content-Type": "application/json",
            }
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())

        text = data["content"][0]["text"]
        return text.strip() if text else None
    except Exception as e:
        log.error(f"Anthropic API error ({model}): {e}")
        return None


# ─── Voice Support ───────────────────────────────────────────────

def get_voice_file_id(message_id):
    """Find the file_id for a voice message using timestamp proximity."""
    db = sqlite3.connect(SIMPLEX_DB)
    try:
        msg = db.execute(
            'SELECT created_at FROM messages WHERE message_id = ? AND group_id = 1',
            (message_id,)
        ).fetchone()
        if not msg:
            return None

        row = db.execute('''
            SELECT file_id FROM files
            WHERE group_id = 1 AND file_name LIKE '%voice%.m4a'
            AND ABS(julianday(created_at) - julianday(?)) < 0.00006
            ORDER BY file_id DESC LIMIT 1
        ''', (msg[0],)).fetchone()

        if row:
            return row[0]

        row = db.execute('''
            SELECT file_id FROM files
            WHERE group_id = 1 AND file_name LIKE '%.m4a'
            AND ABS(julianday(created_at) - julianday(?)) < 0.00035
            ORDER BY file_id DESC LIMIT 1
        ''', (msg[0],)).fetchone()
        return row[0] if row else None
    finally:
        db.close()


def download_simplex_file(file_id):
    """Download a SimpleX file. Returns file path or None."""
    db = sqlite3.connect(SIMPLEX_DB)
    row = db.execute('SELECT file_path, ci_file_status FROM files WHERE file_id = ?', (file_id,)).fetchone()
    db.close()
    if row and row[1] == 'rcv_complete' and row[0]:
        log.info(f"File {file_id} already downloaded: {row[0]}")
        return row[0]

    try:
        import websockets

        async def _download():
            uri = f'ws://{SIMPLEX_WS_HOST}:{SIMPLEX_WS_PORT}'
            async with websockets.connect(uri) as ws:
                msg = {"corrId": f"recv_{file_id}", "cmd": f"/freceive {file_id}"}
                await ws.send(json.dumps(msg))
                for _ in range(10):
                    try:
                        resp = await asyncio.wait_for(ws.recv(), timeout=5)
                        parsed = json.loads(resp)
                        rtype = parsed.get('resp', {}).get('type', '')
                        if 'error' in rtype.lower():
                            log.error(f"Download error: {rtype}")
                            break
                    except asyncio.TimeoutError:
                        break

        asyncio.run(_download())

        for _ in range(60):
            time.sleep(1)
            db = sqlite3.connect(SIMPLEX_DB)
            row = db.execute(
                'SELECT file_path, ci_file_status FROM files WHERE file_id = ?',
                (file_id,)
            ).fetchone()
            db.close()
            if row and row[1] == 'rcv_complete' and row[0]:
                log.info(f"File {file_id} downloaded: {row[0]}")
                return row[0]

        log.warning(f"File {file_id} download timeout")
        return None
    except Exception as e:
        log.error(f"File download error: {e}")
        return None


def transcribe_voice(file_path):
    """Transcribe a voice file using Whisper."""
    try:
        result = subprocess.run(
            [WHISPER_BIN, file_path, "--model", "small", "--language", "en",
             "--device", "cuda", "--output_format", "txt"],
            capture_output=True, text=True, timeout=180, cwd="/tmp"
        )
        if result.returncode == 0:
            lines = result.stderr.split('\n') + result.stdout.split('\n')
            transcript = []
            for line in lines:
                if line.strip().startswith('[') and '-->' in line:
                    parts = line.split(']', 1)
                    if len(parts) > 1:
                        transcript.append(parts[1].strip())
            return ' '.join(transcript) if transcript else None
        log.error(f"Whisper failed (rc={result.returncode}): {result.stderr[:200]}")
        return None
    except Exception as e:
        log.error(f"Transcription error: {e}")
        return None


# ─── Message Retrieval ───────────────────────────────────────────

def get_new_messages(since_id):
    """Get new SimpleX group messages since last processed ID."""
    db = sqlite3.connect(SIMPLEX_DB)
    try:
        msgs = db.execute("""
            SELECT m.message_id, m.created_at, m.msg_body, m.chat_msg_event,
                   m.author_group_member_id,
                   gmp.display_name
            FROM messages m
            LEFT JOIN group_members gm ON m.author_group_member_id = gm.group_member_id
            LEFT JOIN contact_profiles gmp ON gm.member_profile_id = gmp.contact_profile_id
            WHERE m.group_id = 1
            AND m.message_id > ?
            ORDER BY m.message_id ASC
        """, [since_id]).fetchall()

        results = []
        for msg in msgs:
            msg_id, created, body, event, author_id, display_name = msg

            if author_id is None:
                continue
            if author_id in ALEXANDRE_MEMBER_IDS:
                continue

            if isinstance(body, bytes):
                body = body.decode('utf-8', errors='replace')

            try:
                parsed = json.loads(body)
                if 'params' in parsed:
                    content = parsed['params'].get('content', {})
                    text = content.get('text', '')
                    msg_type = content.get('type', 'text')
                else:
                    text = ''
                    msg_type = '?'
            except:
                text = body if body else ''
                msg_type = '?'

            sender = display_name or f'member_{author_id}'

            if msg_type == 'voice':
                log.info(f"Voice message from {sender} (msg_id={msg_id})")
                voice_file_id = get_voice_file_id(msg_id)
                transcript = None

                if voice_file_id:
                    log.info(f"Downloading voice file_id={voice_file_id}...")
                    file_path = download_simplex_file(voice_file_id)
                    if file_path:
                        log.info(f"Transcribing {file_path}...")
                        transcript = transcribe_voice(file_path)
                        if transcript:
                            log.info(f"Transcript: {transcript[:100]}...")
                else:
                    log.warning(f"Could not find file_id for voice msg {msg_id}")

                if transcript:
                    results.append({
                        'id': msg_id, 'created': created, 'sender': sender,
                        'author_id': author_id,
                        'text': f"[Voice message transcription]: {transcript}",
                    })
                else:
                    results.append({
                        'id': msg_id, 'created': created, 'sender': sender,
                        'author_id': author_id,
                        'text': '[Voice message received - I had trouble processing it. Could you type your message instead? Thank you!]',
                    })

            elif text and msg_type in ('text', ''):
                results.append({
                    'id': msg_id, 'created': created, 'sender': sender,
                    'author_id': author_id, 'text': text,
                })

        return results
    finally:
        db.close()


# ─── SearXNG Search ──────────────────────────────────────────────

SEARCH_TRIGGERS = [
    "what is", "who is", "where is", "when is", "how to", "how do",
    "latest", "news", "price", "cost", "weather", "recipe",
    "search", "look up", "find", "google", "current", "today",
    "best", "top", "review", "recommend", "compare", "vs",
    "score", "result", "release", "update", "2025", "2026",
]


def should_search(message):
    """Heuristic: does this message benefit from a web search?"""
    msg_lower = message.lower()
    if any(trigger in msg_lower for trigger in SEARCH_TRIGGERS):
        return True
    if '?' in message and len(message) > 20:
        return True
    return False


def searxng_search(query, num_results=5):
    """Query local SearXNG and return formatted results."""
    try:
        params = urllib.parse.urlencode({"q": query, "format": "json", "engines": "google,duckduckgo,brave,wikipedia"})
        req = urllib.request.Request(f"{SEARXNG_URL}?{params}", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())

        results = data.get("results", [])[:num_results]
        if not results:
            return None

        formatted = []
        for r in results:
            title = r.get("title", "")
            snippet = r.get("content", "")
            url = r.get("url", "")
            formatted.append(f"• {title}\n  {snippet}\n  {url}")

        return "\n\n".join(formatted)
    except Exception as e:
        log.warning(f"SearXNG search failed: {e}")
        return None


# ─── AI Tier System ──────────────────────────────────────────────

def is_complex(message):
    """Determine if a message is complex (kept for logging/future use)."""
    msg_lower = message.lower()
    if len(message) > 200:
        return True
    if message.count('?') >= 2:
        return True
    for indicator in COMPLEX_INDICATORS:
        if indicator in msg_lower:
            return True
    return False



# ─── pgvector Memory ─────────────────────────────────────────────

def pgvec_search(query, limit=5):
    """Search pgvector for relevant memories before composing response."""
    try:
        result = subprocess.run(
            [PGVEC_SEARCH_BIN, query],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            lines = result.stdout.strip().split('\n')
            return '\n'.join(lines[:limit * 3])
        return ""
    except Exception as e:
        log.warning(f"pgvec search failed: {e}")
        return ""


def pgvec_store(content, sender="Farheen"):
    """Store significant exchange in pgvector for long-term memory."""
    import time
    source_id = f"simplex-{sender.lower()}-{int(time.time())}"
    try:
        result = subprocess.run(
            [PGVEC_STORE_BIN, "simplex", f"simplex/{sender.lower()}", source_id, sender, content],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            log.info(f"📝 Stored memory: {content[:60]}...")
            return True
        return False
    except Exception as e:
        log.warning(f"pgvec store failed: {e}")
        return False


def ask_agent(message, sender):
    """Sonnet 4.6 with pgvector memory + SearXNG search. Memory-first architecture."""
    # 1. ALWAYS search pgvector first — long-term memory retrieval
    memory_context = ""
    mem_results = pgvec_search(message)
    if mem_results:
        memory_context = f"\n\n[Your memories — relevant knowledge from past conversations]:\n{mem_results}\n"
        log.info(f"🧠 Retrieved {mem_results.count(chr(10))} memory lines")

    # 2. Search web if useful
    search_context = ""
    if should_search(message):
        log.info(f"🔍 Searching SearXNG for: {message[:80]}")
        results = searxng_search(message)
        if results:
            search_context = f"\n\n[Web search results for context — use these to give accurate, up-to-date answers]:\n{results}\n"
            log.info(f"📎 Got {results.count(chr(39))} search results")

    # 3. Compose message with memory + search context
    user_content = f"[From {sender}]: {message}"
    if memory_context:
        user_content += memory_context
    if search_context:
        user_content += search_context

    messages = [
        {"role": "system", "content": ASSISTANT_SYSTEM},
        {"role": "user", "content": user_content}
    ]

    log.info(f"→ {MODEL}")
    response = call_anthropic(messages, MODEL)

    if not response:
        return "I'm sorry, something went wrong. Please try again."

    # 4. Store significant exchanges in pgvector
    if len(message) > 30:  # Skip trivial messages like "hi" or "ok"
        exchange = f"Q ({sender}): {message[:300]}\nA: {response[:300]}"
        pgvec_store(exchange, sender)

    return response


# ─── SimpleX Send ────────────────────────────────────────────────

def send_simplex(text):
    """Send a text message to EffuzionNext group via websockets."""
    try:
        import websockets

        async def _send():
            uri = f'ws://{SIMPLEX_WS_HOST}:{SIMPLEX_WS_PORT}'
            async with websockets.connect(uri) as ws:
                try:
                    while True:
                        await asyncio.wait_for(ws.recv(), timeout=1)
                except asyncio.TimeoutError:
                    pass

                cmd = json.dumps({
                    "corrId": f"router_{int(time.time())}",
                    "cmd": f"#EffuzionNext {text}"
                })
                await ws.send(cmd)
                resp = await asyncio.wait_for(ws.recv(), timeout=10)
                return "newChatItems" in resp

        return asyncio.run(_send())
    except Exception as e:
        log.error(f"SimpleX send error: {e}")
        return False


# ─── Main Loop ───────────────────────────────────────────────────

def main():
    log.info(f"SimpleX Router v5 — Anthropic Sonnet 4.6 ({MODEL})")
    log.info(f"Alexandre member IDs (skip): {ALEXANDRE_MEMBER_IDS}")

    state = load_state()
    log.info(f"Resuming from message_id: {state['last_message_id']}")

    while True:
        try:
            messages = get_new_messages(state['last_message_id'])

            for msg in messages:
                log.info(f"New message from {msg['sender']}: {msg['text'][:100]}...")

                response = ask_agent(msg['text'], msg['sender'])
                log.info(f"Response: {response[:100]}...")

                reply = f"@Farheen {response}"
                success = send_simplex(reply)

                if success:
                    log.info("✅ Reply sent to SimpleX")
                else:
                    log.warning("⚠️ Failed to send reply")

                state['last_message_id'] = msg['id']
                state['last_processed'] = msg['created']
                save_state(state)

        except Exception as e:
            log.error(f"Poll error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
