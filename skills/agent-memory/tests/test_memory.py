"""
Tests for AgentMemory
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.memory import AgentMemory
import tempfile
import os


def test_basic_facts():
    """Test basic fact operations."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = f.name
    
    try:
        mem = AgentMemory(db_path)
        
        # Remember
        fact_id = mem.remember("Test fact", tags=["test"])
        assert fact_id is not None
        
        # Recall
        facts = mem.recall("Test fact")
        assert len(facts) >= 1
        assert facts[0].content == "Test fact"
        assert "test" in facts[0].tags
        
        # Get specific
        fact = mem.get_fact(fact_id)
        assert fact is not None
        assert fact.id == fact_id
        
        # Forget
        mem.forget(fact_id)
        fact = mem.get_fact(fact_id)
        assert fact is None
        
        print("✅ Basic facts test passed")
    finally:
        os.unlink(db_path)


def test_lessons():
    """Test lesson learning."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = f.name
    
    try:
        mem = AgentMemory(db_path)
        
        # Learn
        lesson_id = mem.learn(
            action="Test action",
            context="testing",
            outcome="positive",
            insight="Tests are good"
        )
        assert lesson_id is not None
        
        # Get lessons
        lessons = mem.get_lessons(context="testing")
        assert len(lessons) >= 1
        assert lessons[0].action == "Test action"
        assert lessons[0].outcome == "positive"
        
        # Filter by outcome
        positive = mem.get_lessons(outcome="positive")
        assert len(positive) >= 1
        
        negative = mem.get_lessons(outcome="negative")
        assert len(negative) == 0
        
        print("✅ Lessons test passed")
    finally:
        os.unlink(db_path)


def test_entities():
    """Test entity tracking."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = f.name
    
    try:
        mem = AgentMemory(db_path)
        
        # Track
        entity_id = mem.track_entity(
            "TestPerson",
            "person",
            {"role": "tester"}
        )
        assert entity_id is not None
        
        # Get
        entity = mem.get_entity("TestPerson", "person")
        assert entity is not None
        assert entity.name == "TestPerson"
        assert entity.attributes["role"] == "tester"
        
        # Update
        mem.track_entity("TestPerson", "person", {"role": "senior tester"})
        entity = mem.get_entity("TestPerson", "person")
        assert entity.attributes["role"] == "senior tester"
        
        print("✅ Entities test passed")
    finally:
        os.unlink(db_path)


def test_supersede():
    """Test fact superseding."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = f.name
    
    try:
        mem = AgentMemory(db_path)
        
        # Create original
        old_id = mem.remember("Old fact")
        
        # Supersede
        new_id = mem.supersede(old_id, "New fact")
        
        # Old fact should be superseded
        old_fact = mem.get_fact(old_id)
        assert old_fact.superseded_by == new_id
        
        # Recall should return new fact, not old
        facts = mem.recall("fact")
        contents = [f.content for f in facts]
        assert "New fact" in contents
        # Old fact shouldn't appear in results (superseded)
        
        print("✅ Supersede test passed")
    finally:
        os.unlink(db_path)


def test_stats():
    """Test statistics."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = f.name
    
    try:
        mem = AgentMemory(db_path)
        
        mem.remember("Fact 1")
        mem.remember("Fact 2")
        mem.learn("Action", "context", "positive", "insight")
        mem.track_entity("Entity", "type", {})
        
        stats = mem.stats()
        assert stats["active_facts"] == 2
        assert stats["lessons"] == 1
        assert stats["entities"] == 1
        
        print("✅ Stats test passed")
    finally:
        os.unlink(db_path)


def test_export():
    """Test JSON export."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = f.name
    
    try:
        mem = AgentMemory(db_path)
        
        mem.remember("Export test fact", tags=["export"])
        mem.learn("Export action", "export", "neutral", "Export insight")
        mem.track_entity("ExportEntity", "test", {"key": "value"})
        
        data = mem.export_json()
        
        assert "exported_at" in data
        assert len(data["facts"]) >= 1
        assert len(data["lessons"]) >= 1
        assert len(data["entities"]) >= 1
        
        print("✅ Export test passed")
    finally:
        os.unlink(db_path)


if __name__ == "__main__":
    test_basic_facts()
    test_lessons()
    test_entities()
    test_supersede()
    test_stats()
    test_export()
    print("\n🎉 All tests passed!")
