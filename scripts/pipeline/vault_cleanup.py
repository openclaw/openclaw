# Source Generated with Decompyle++
# File: vault_cleanup.cpython-39.pyc (Python 3.9)

'''
Obsidian Knowledge Vault Cleanup Script
========================================
Scans zk/inbox/ and zk/notes/ for noise notes, moves them to archive/noise/,
updates note_registry.json, removes dangling links, and cleans up top-level files.

Safety:
- Creates backup of note_registry.json before modification
- Moves (never deletes) .md files to archive/noise/
- Does NOT touch philosophy/, portfolio/, or ops/

Noise categories:
1. separator_title       — title is only separator chars (━━━, ───, ═══)
2. celebration           — "Done! Congratulations" bot creation messages
3. bot_token_leak        — contains bot API tokens (security risk)
4. template_placeholder  — unfilled template (_________, 20XX placeholders)
5. emoji_reaction        — just emoji reactions or single meaningless words
6. url_only              — body is just a bare URL with no commentary
7. test_note             — explicit test notes ("테스트 노트", "test")
8. chat_fragment         — 1-line telegram chat with no analytical content
9. duplicate             — identical body content as another note (keep older)
'''
import json
import os
import re
import shutil
import hashlib
from datetime import datetime
from pathlib import Path
from collections import defaultdict
from shared.vault_paths import VAULT
INBOX = VAULT / 'zk' / 'inbox'
NOTES = VAULT / 'zk' / 'notes'
ARCHIVE_NOISE = VAULT / 'archive' / 'noise'
SYSTEM = VAULT / 'system'
REGISTRY_PATH = SYSTEM / 'note_registry.json'
BACKUP_PATH = SYSTEM / 'backups' / 'note_registry_pre_cleanup_20260215.json'
PROTECTED_DIRS = {
    'philosophy',
    'portfolio',
    'ops'}
SEPARATOR_TITLE_PATTERN = re.compile('^[━─═\\s\\-_\\.\\|┌┐└┘├┤┬┴┼│┏┓┗┛┣┫┳┻╋┃note]+$')
CELEBRATION_PATTERNS = [
    re.compile('(?i)done!\\s*congratul'),
    re.compile('(?i)^congratulations?\\s+on\\s+your')]
BOT_TOKEN_PATTERN = re.compile('\\d{8,10}:[A-Za-z0-9_-]{30,}')
URL_ONLY_BODY = re.compile('^https?://\\S+$')
TEST_NOTE_TITLES = re.compile('^(테스트\\s*노트|test\\s*note|testing)$', re.IGNORECASE)
PROTECTED_SOURCES = {
    'n8n-pipeline',
    'ops_agent_memory',
    'knowledge/'}
PROTECTED_TOPICS = {
    'ops',
    '통합검증',
    'strategy'}
PROTECTED_TAGS_TERMS = {
    'stock_analysis',
    'composition',
    'policy',
    'confidence',
    'source',
    'index',
    'market_view',
    'pipeline',
    'prompt',
    'sector_trend',
    'n8n',
    'quality',
    'portfolio_signal'}
CHAT_INDICATORS = [
    re.compile('ㅋㅋ'),
    re.compile('ㅎㅎ'),
    re.compile('읽어볼게'),
    re.compile('보내줄게'),
    re.compile('검색해.*줄게'),
    re.compile('엇단게$'),
    re.compile('데용$'),
    re.compile('해서$')]

def parse_frontmatter(filepath):
    '''Parse YAML frontmatter and body from a note file.'''
    pass
# WARNING: Decompyle incomplete


def get_body_content(body):
    pass  # FIXME: function body lost in decompilation
