#!/usr/bin/env python3
"""Session Memory Sync v2.0 - OpenClaw cross-topic memory synchronization
Author: Constantine V (V 👾)
Acknowledgments: epro-memory by Toby Bridges (Apache 2.0)
https://github.com/toby-bridges/epro-memory
"""
import os, json, logging, sqlite3
from datetime import datetime, timedelta
from pathlib import Path

logging.basicConfig(level=logging.WARNING, format='[%(levelname)s] %(message)s')
logger = logging.getLogger('memory-sync')

DEFAULT_CONFIG = {'DAYS_TO_READ': 2, 'MAX_FACTS': 5, 'INCLUDE_FINISHED': False,
                  'LOG_LEVEL': 'WARNING', 'ENABLE_EPRO_MEMORY': True, 'EPRO_MEMORY_LIMIT': 3}

def load_config():
    config = DEFAULT_CONFIG.copy()
    config_path = Path.home() / '.openclaw/memory-sync.conf'
    if config_path.exists():
        try:
            with open(config_path) as f:
                config.update(json.load(f))
        except Exception as e:
            logger.warning(f"Config load failed: {e}")
    return config

def get_workspace():
    return os.environ.get('OPENCLAW_WORKSPACE', os.path.expanduser('~/.openclaw/workspace'))

def get_agent_path():
    return os.environ.get('OPENCLAW_AGENT_PATH', os.path.expanduser('~/.openclaw/agents/main'))

def read_memory_md():
    memory_path = os.path.join(get_workspace(), 'MEMORY.md')
    key_facts = []
    keywords = ['默认模型', '配置', '任务', '问题', '解决方案', 'default model',
                'config', 'task', 'project', 'PR', 'model', 'backup', 'cron']
    try:
        with open(memory_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if any(kw in line.lower() for kw in keywords):
                    clean = line.lstrip('- *').strip()
                    if len(clean) > 5:
                        key_facts.append(clean)
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.debug(f"MEMORY.md read error: {e}")
    return key_facts

def read_daily_notes(days=2, max_per_day=3):
    memory_dir = os.path.join(get_workspace(), 'memory')
    recent_facts = []
    if not os.path.exists(memory_dir):
        return recent_facts
    for i in range(days):
        date = (datetime.now() - timedelta(days=i)).strftime('%Y-%m-%d')
        note_path = os.path.join(memory_dir, f'{date}.md')
        if not os.path.exists(note_path):
            continue
        try:
            with open(note_path, encoding='utf-8') as f:
                day_facts = []
                for line in f:
                    line = line.strip()
                    if not (line.startswith('- ') or line.startswith('## ')):
                        continue
                    clean = line.lstrip('- #').strip()
                    if len(clean) <= 10 or clean.lower().startswith('memory'):
                        continue
                    if line.startswith('- [x]') and not config.get('INCLUDE_FINISHED'):
                        continue
                    day_facts.append(clean)
                    if len(day_facts) >= max_per_day:
                        break
                recent_facts.extend(day_facts)
        except Exception as e:
            logger.debug(f"Note read error: {e}")
    return recent_facts

def read_epro_memory(limit=3):
    if not config.get('ENABLE_EPRO_MEMORY'):
        return []
    agent_path = get_agent_path()
    paths = [os.path.join(agent_path, 'memory.db'),
             os.path.join(agent_path, '.agent/memory.db'),
             os.path.expanduser('~/.openclaw/workspace/.agent/memory.db')]
    for db_path in paths:
        if not os.path.exists(db_path):
            continue
        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute('SELECT content FROM memories ORDER BY timestamp DESC LIMIT ?', (limit,))
            memories = [row[0] for row in cursor.fetchall() if len(row[0]) < 500]
            conn.close()
            return memories
        except Exception:
            continue
    return []

def generate_summary():
    all_facts = read_memory_md() + read_daily_notes(config.get('DAYS_TO_READ', 2))
    if config.get('ENABLE_EPRO_MEMORY'):
        all_facts.extend(read_epro_memory(config.get('EPRO_MEMORY_LIMIT', 3)))
    seen = set()
    unique = []
    for fact in all_facts:
        norm = fact.lower().strip()
        if norm and norm not in seen:
            seen.add(norm)
            unique.append(fact)
    max_facts = config.get('MAX_FACTS', 5)
    unique = unique[:max_facts]
    if not unique:
        return '[Memory Sync] No important items'
    if len(unique) <= 3:
        summary = ' | '.join(unique)
    else:
        summary = f'{unique[0][:60]}... (+{len(unique)-1})'
    return f'[Memory Sync] {summary[:200]}'

def main():
    global config
    config = load_config()
    log_level = config.get('LOG_LEVEL', 'WARNING')
    logging.getLogger().setLevel(getattr(logging, log_level.upper(), logging.WARNING))
    try:
        print(generate_summary())
        return 0
    except Exception as e:
        logger.error(f'Sync failed: {e}')
        print('[Memory Sync] Error')
        return 1

if __name__ == '__main__':
    import sys
    sys.exit(main())
