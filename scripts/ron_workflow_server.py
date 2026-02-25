#!/usr/bin/env python3
"""
ron_workflow_server.py - 경량 워크플로우 서버
n8n 대안으로 Python/FastAPI 기반 실시간 처리
"""

import os
import sys
import json
import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict
from contextlib import asynccontextmanager
from shared.db import resolve_ops_db_path

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Paths
from shared.vault_paths import VAULT, INBOX as _VAULT_INBOX

WORKSPACE = Path.home() / ".openclaw" / "workspace"
PROCESSORS = WORKSPACE / "processors"
INBOX = _VAULT_INBOX / "111_raw"

def ensure_dirs():
    """필요한 디렉토리 생성"""
    INBOX.mkdir(parents=True, exist_ok=True)
    for subdir in ["ingest", "enrich", "transform", "structure", "output"]:
        (PROCESSORS / subdir).mkdir(parents=True, exist_ok=True)

@dataclass
class WorkflowEvent:
    """워크플로우 이벤트"""
    id: str
    source: str  # twitter, youtube, github, telegram
    type: str    # create, update, delete
    content: Dict[str, Any]
    timestamp: str
    status: str = "pending"  # pending, processing, completed, error
    
    def to_dict(self):
        return asdict(self)

class WorkflowEngine:
    """워크플로우 엔진"""
    
    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.processors: Dict[str, callable] = {}
        self.running = False
        
    def register_processor(self, name: str, func: callable):
        """프로세서 등록"""
        self.processors[name] = func
        logger.info(f"Registered processor: {name}")
    
    async def ingest(self, event: WorkflowEvent) -> WorkflowEvent:
        """1단계: 수집"""
        logger.info(f"[INGEST] {event.id} from {event.source}")
        
        # 파일로 저장
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = f"{timestamp}_{event.source}_{event.id}.json"
        filepath = INBOX / filename
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(event.to_dict(), f, ensure_ascii=False, indent=2)
        
        event.status = "ingested"
        return event
    
    async def enrich(self, event: WorkflowEvent) -> WorkflowEvent:
        """2단계: 보강"""
        logger.info(f"[ENRICH] {event.id}")
        
        # TODO: AI 요약, 키워드 추출
        # content = event.content.get("text", "")
        # summary = await ai_summarize(content)
        
        event.status = "enriched"
        return event
    
    async def transform(self, event: WorkflowEvent) -> WorkflowEvent:
        """3단계: 변환"""
        logger.info(f"[TRANSFORM] {event.id}")
        
        # TODO: 마크다운 변환, 원자화
        
        event.status = "transformed"
        return event
    
    async def structure(self, event: WorkflowEvent) -> WorkflowEvent:
        """4단계: 구조화 (MOC 업데이트)"""
        logger.info(f"[STRUCTURE] {event.id}")
        
        # TODO: MOC 연결, PARA 분류
        # keywords = extract_keywords(event.content)
        # update_moc(keywords, event)
        
        event.status = "structured"
        return event
    
    async def output(self, event: WorkflowEvent) -> WorkflowEvent:
        """5단계: 출력"""
        logger.info(f"[OUTPUT] {event.id}")
        
        # TODO: 가설 생성, 실행 항목 추출
        
        event.status = "completed"
        return event
    
    async def process_event(self, event: WorkflowEvent):
        """이벤트 처리 파이프라인"""
        try:
            stages = [
                self.ingest,
                self.enrich,
                self.transform,
                self.structure,
                self.output
            ]
            
            for stage in stages:
                event = await stage(event)
                await asyncio.sleep(0.1)  # Simulate processing
            
            logger.info(f"[COMPLETED] {event.id}")
            
        except Exception as e:
            logger.error(f"[ERROR] {event.id}: {e}")
            event.status = "error"
    
    async def worker(self):
        """워커 루프"""
        while self.running:
            try:
                event = await asyncio.wait_for(self.queue.get(), timeout=1.0)
                await self.process_event(event)
                self.queue.task_done()
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.error(f"Worker error: {e}")
    
    async def start(self, num_workers: int = 3):
        """엔진 시작"""
        self.running = True
        logger.info(f"Starting workflow engine with {num_workers} workers")
        
        workers = [asyncio.create_task(self.worker()) for _ in range(num_workers)]
        await asyncio.gather(*workers)
    
    def stop(self):
        """엔진 중지"""
        self.running = False
        logger.info("Stopping workflow engine")
    
    async def submit(self, event: WorkflowEvent):
        """이벤트 제출"""
        await self.queue.put(event)
        logger.info(f"[SUBMITTED] {event.id}")

# Webhook handlers
class WebhookServer:
    """웹훅 서버"""
    
    def __init__(self, engine: WorkflowEngine):
        self.engine = engine
    
    async def handle_twitter(self, data: Dict) -> Dict:
        """Twitter 웹훅 처리"""
        event = WorkflowEvent(
            id=data.get("id", str(datetime.now().timestamp())),
            source="twitter",
            type="create",
            content=data,
            timestamp=datetime.now().isoformat()
        )
        await self.engine.submit(event)
        return {"status": "accepted", "id": event.id}
    
    async def handle_youtube(self, data: Dict) -> Dict:
        """YouTube 웹훅 처리"""
        event = WorkflowEvent(
            id=data.get("video_id", str(datetime.now().timestamp())),
            source="youtube",
            type="create",
            content=data,
            timestamp=datetime.now().isoformat()
        )
        await self.engine.submit(event)
        return {"status": "accepted", "id": event.id}
    
    async def handle_github(self, data: Dict) -> Dict:
        """GitHub 웹훅 처리"""
        event = WorkflowEvent(
            id=data.get("release_id", str(datetime.now().timestamp())),
            source="github",
            type="create",
            content=data,
            timestamp=datetime.now().isoformat()
        )
        await self.engine.submit(event)
        return {"status": "accepted", "id": event.id}

# CLI interface
async def main():
    """메인 함수"""
    ensure_dirs()
    
    engine = WorkflowEngine()
    webhooks = WebhookServer(engine)
    
    # 테스트 이벤트
    test_event = WorkflowEvent(
        id="test-001",
        source="twitter",
        type="create",
        content={"text": "Test tweet about AI and semiconductors"},
        timestamp=datetime.now().isoformat()
    )
    
    await engine.submit(test_event)
    
    # Start engine
    try:
        await engine.start(num_workers=2)
    except KeyboardInterrupt:
        engine.stop()
        logger.info("Shutdown complete")

if __name__ == "__main__":
    asyncio.run(main())


# ============================================================
# 아키텍처/설계 질문 위임 로직 (2026-02-24 추가)
# ============================================================

def should_delegate_to_cowork(user_message: str) -> bool:
    """아키텍처/설계 관련 질문인지 확인"""
    keywords = [
        # 한국어
        "아키텍처", "설계", "架构", "설계도", "구조 설계", "시스템 설계",
        "어떻게", "왜那样", "방법", "원리", "개념", "설명해줘",
        # 영어
        "architecture", "design", "structure", "how does", "why is", 
        "explain", "concept", "architecture diagram", "system design"
    ]
    msg_lower = user_message.lower()
    return any(kw in msg_lower for kw in keywords)


def delegate_to_cowork(user_message: str) -> dict:
    """cowork에 위임 태스크 생성"""
    import uuid
    from datetime import datetime
    
    # bus_commands에 직접 추가 (sqlite)
    import sqlite3
    
    db_path = resolve_ops_db_path()
    task_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now().isoformat()
    
    try:
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        
        # bus_commands 테이블에 태스크 삽입
        cursor.execute("""
            INSERT INTO bus_commands (id, agent, command, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (task_id, 'cowork', f"[아키텍처 검토 요청]\n\n{user_message[:2000]}", 'queued', timestamp, timestamp))
        
        conn.commit()
        conn.close()
        
        return {
            "delegated": True,
            "agent": "cowork",
            "task_id": task_id,
            "message": "cowork에 위임되었습니다. 잠시 후 결과를 받아립니다."
        }
    except Exception as e:
        return {
            "delegated": False,
            "error": str(e),
            "message": "위임 중 오류가 발생했습니다."
        }


# 사용 예시:
# if should_delegate_to_cowork(user_message):
#     result = delegate_to_cowork(user_message)
#     print(result["message"])


# ============================================================
# 에이전트별 질문 위임 로직 (2026-02-24 추가)
# ============================================================

def detect_agent_from_message(user_message: str) -> str:
    """사용자 메시지에서 적절한 에이전트 식별 (빈 문자열=위임 불필요)"""
    msg_lower = user_message.lower()
    
    # 코덱스: 코딩, 스크립트, 버그, 구현
    codex_keywords = [
        "코딩", "코드", "스크립트", "프로그래밍", "파이썬", "python",
        "버그", "에러", "수정", "구현", "함수", "클래스",
        "coding", "code", "script", "bug", "implement", "function",
        "帮我写", "代码", "프로그래밍", "만들어줘", "작성해줘"
    ]
    if any(kw in msg_lower for kw in codex_keywords):
        return "codex"
    
    # 가디언: 시스템, 프로세스, 디스크, 보안, 모니터링
    guardian_keywords = [
        "시스템", "프로세스", "디스크", "메모리", "cpu", "보안",
        "모니터링", "상태", "점검", "health", "check", 
        "system", "process", "disk", "memory", "security",
        "작동", "실행", "중지", "멈춤", "문제"
    ]
    if any(kw in msg_lower for kw in guardian_keywords):
        return "guardian"
    
    # 데이터 분석가: 투자, 금융, ETF, 주식, 섹터, 분석
    analyst_keywords = [
        "투자", "금융", "etf", "주식", "포트폴리오", "섹터",
        "분석", "데이터", "수익", "가격", "conviction",
        "investment", "finance", "stock", "portfolio", "sector",
        "분석해줘", "추천", "어떤 게", "뭐가 좋을"
    ]
    if any(kw in msg_lower for kw in analyst_keywords):
        return "data-analyst"
    
    # 아키텍처/설계 (기존 coworkers) - 개선됨
    architecture_keywords = [
        "아키텍처", "설계", "架构", "어떻게", "왜那样", "원리", "구조",
        "architecture", "design", "structure", "how does", "why", "system",
        "에이전트", "적용", "전반적", "전체", "전체 구조", "전체적"
    ]
    if any(kw in msg_lower for kw in architecture_keywords):
        return "cowork"
    
    return ""  # 위임 필요 없음


def delegate_to_agent(user_message: str, agent_name: str = None) -> dict:
    """지정된 에이전트에 위임 (자동 또는 수동)"""
    import sqlite3
    from pathlib import Path
    from datetime import datetime
    
    # 에이전트가 지정되지 않으면 자동 감지
    if not agent_name:
        agent_name = detect_agent_from_message(user_message)
    
    if not agent_name:
        return {
            "delegated": False,
            "message": "위임할 에이전트를 찾을 수 없습니다."
        }
    
    # 유효한 에이전트 목록
    valid_agents = ["codex", "cowork", "guardian", "data-analyst"]
    if agent_name not in valid_agents:
        return {
            "delegated": False,
            "message": f"알 수 없는 에이전트: {agent_name}"
        }
    
    db_path = resolve_ops_db_path()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    # 에이전트별 제목 접두사
    agent_prefix = {
        "codex": "[코드 작성]",
        "cowork": "[아키텍처 검토]",
        "guardian": "[시스템 점검]",
        "data-analyst": "[데이터 분석]"
    }
    
    try:
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO bus_commands (title, body, requested_by, target_agent, status, priority, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            f"{agent_prefix.get(agent_name, '['+agent_name+']')} {user_message[:40]}...",
            f"[{agent_name} 요청]\n\n{user_message[:3000]}",
            'harry',
            agent_name,
            'queued',
            'high',
            timestamp,
            timestamp
        ))
        
        conn.commit()
        task_id = cursor.lastrowid
        conn.close()
        
        return {
            "delegated": True,
            "agent": agent_name,
            "task_id": task_id,
            "message": f"✅ {agent_name}에 위임되었습니다. (task_id: {task_id})"
        }
    except Exception as e:
        return {
            "delegated": False,
            "error": str(e),
            "message": f"위임 중 오류: {str(e)[:100]}"
        }


# ============================================================
# Cowork 분석 결과 자동 실행 (2026-02-24 추가)
# ============================================================

def check_cowork_recommendations():
    """cowork의 분석 결과를 확인하고 자동으로 실행"""
    import sqlite3
    from pathlib import Path
    import json
    
    db_path = resolve_ops_db_path()
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    
    # coworker 완료된 분석 결과 찾기
    cursor.execute("""
        SELECT id, title, body, result_note, completed_at
        FROM bus_commands 
        WHERE target_agent = 'cowork' 
          AND status = 'done'
          AND result_note IS NOT NULL
          AND title LIKE '%크론%'
        ORDER BY completed_at DESC 
        LIMIT 1
    """)
    
    row = cursor.fetchone()
    if not row:
        conn.close()
        return "분석 결과 없음"
    
    task_id, title, body, result_note, completed_at = row
    
    # 이미 처리했는지 확인 (result_note에 실행 결과 포함 여부)
    if "[실행완료]" in (result_note or ""):
        conn.close()
        return "이미 처리됨"
    
    # 크론 비활성화 권고 찾기
    import re
    
    # "비활성화" 또는 "disabled" 언급 찾기
    disable_patterns = re.findall(r'.*?(?:비활성화|disabled|중지).*?([a-zA-Z0-9_-]+).*?', result_note or '', re.IGNORECASE)
    
    jobs_path = Path.home() / ".openclaw/cron/jobs.json"
    changes = []
    
    if disable_patterns and jobs_path.exists():
        with open(jobs_path) as f:
            jobs_data = json.load(f)
        
        for job in jobs_data.get('jobs', []):
            job_name = job.get('name', '')
            job_id = job.get('id', '')
            
            # 권고된 크론이면 비활성화
            for pattern in disable_patterns:
                if pattern.lower() in job_name.lower() or pattern.lower() in job_id.lower():
                    if job.get('enabled', True):
                        job['enabled'] = False
                        changes.append(f"❌ 비활성화: {job_name}")
        
        if changes:
            with open(jobs_path, 'w') as f:
                json.dump(jobs_data, f, indent=2, ensure_ascii=False)
            
            # 실행 완료 표시
            result_note_with_marker = (result_note or "") + "\n\n[실행완료] " + "\n".join(changes)
            cursor.execute(
                "UPDATE bus_commands SET result_note = ? WHERE id = ?",
                (result_note_with_marker, task_id)
            )
            conn.commit()
    
    conn.close()
    
    if changes:
        return f"✅ 자동 실행 완료: {len(changes)}개 크론 비활성화\n" + "\n".join(changes)
    else:
        return "실행할 변경사항 없음"


# 사용 예시:
# result = check_cowork_recommendations()
# print(result)
