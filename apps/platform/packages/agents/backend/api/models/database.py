"""
Database connection and session management.
Supports PostgreSQL and SQLite (for dev: DATABASE_URL=sqlite:///./openclaw_agents.db).
"""
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool, StaticPool

from core.config import settings

# SQLite needs different engine options (no pooling, single thread check)
_is_sqlite = settings.database_url.strip().startswith("sqlite")
_engine_kw = {
    "echo": settings.debug,
}
if _is_sqlite:
    _engine_kw["connect_args"] = {"check_same_thread": False}
    _engine_kw["poolclass"] = StaticPool
else:
    _engine_kw["poolclass"] = QueuePool
    _engine_kw["pool_size"] = settings.database_pool_size
    _engine_kw["max_overflow"] = settings.database_max_overflow
    _engine_kw["pool_pre_ping"] = True

engine = create_engine(settings.database_url, **_engine_kw)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for models
Base = declarative_base()


def get_db():
    """Dependency for getting database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def seed_default_agents(session):
    """Create default agents (Finance Monitor, Operations Manager) if none exist."""
    from .models import Agent, AgentStatus
    if session.query(Agent).count() > 0:
        return
    defaults = [
        Agent(
            name="Finance Monitor",
            slug="finance",
            description="Tracks transactions, Stripe, and financial reports.",
            agent_type="finance",
            status=AgentStatus.IDLE,
            is_enabled=True,
            schedule="0 */6 * * *",  # Every 6 hours
            config={"alert_thresholds": {"large_transaction": 10000, "daily_volume": 100000, "failed_payment_rate": 0.05}},
        ),
        Agent(
            name="Operations Manager",
            slug="operations",
            description="Monitors CI/CD, repositories, and incidents.",
            agent_type="operations",
            status=AgentStatus.IDLE,
            is_enabled=True,
            schedule="0 * * * *",  # Every hour
            config={"repositories": [], "thresholds": {"pipeline_failure_threshold": 3, "stale_pr_days": 7, "max_open_issues": 50}},
        ),
    ]
    for a in defaults:
        session.add(a)
    session.commit()


def init_db():
    """Initialize database tables and seed default agents."""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_default_agents(db)
    except Exception:
        pass
    finally:
        db.close()
