"""
O.R.I.O.N. CORE MODULE: THE HIPPOCAMPUS
========================================
This file is part of THE VAULT - Immutable system files.
Status: PROTECTED - No external updates allowed.

The Memory system provides persistent storage and retrieval of facts,
experiences, and learned knowledge using vector embeddings.
"""

import chromadb
from chromadb.utils import embedding_functions
from datetime import datetime
import os
from typing import List, Dict, Any, Optional


class Memory:
    """
    The Hippocampus - O.R.I.O.N.'s long-term memory system.
    Uses ChromaDB for persistent vector storage and semantic search.
    """

    def __init__(self, persist_directory: str = "./brain_data"):
        """
        Initialize the memory system with persistent storage.

        Args:
            persist_directory: Path to store the ChromaDB database
        """
        # Ensure the brain_data directory exists
        os.makedirs(persist_directory, exist_ok=True)

        # Initialize ChromaDB with persistence
        self.client = chromadb.PersistentClient(path=persist_directory)

        # Initialize the sentence transformer for embeddings
        self.embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name="sentence-transformers/all-MiniLM-L6-v2"
        )

        # Get or create the memories collection
        self.collection = self.client.get_or_create_collection(
            name="orion_memories",
            embedding_function=self.embedding_function,
            metadata={"description": "O.R.I.O.N.'s episodic and semantic memory"}
        )

        print("🧠 Memory system initialized. Database location:", persist_directory)

    def remember(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        """
        Store a new memory with automatic timestamping and embedding.

        Args:
            text: The content to remember
            metadata: Optional metadata dict (tags, source, importance, etc.)

        Returns:
            The unique ID of the stored memory
        """
        # Generate a unique ID based on timestamp
        memory_id = f"mem_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"

        # Add timestamp to metadata
        if metadata is None:
            metadata = {}
        metadata["timestamp"] = datetime.now().isoformat()
        metadata["type"] = metadata.get("type", "general")

        # Store the memory
        self.collection.add(
            documents=[text],
            metadatas=[metadata],
            ids=[memory_id]
        )

        print(f"💾 Memory saved: {memory_id[:20]}... ({len(text)} chars)")
        return memory_id

    def recall(self, query: str, n: int = 3) -> List[Dict[str, Any]]:
        """
        Retrieve the most relevant memories for a given query.

        Args:
            query: The search query
            n: Number of memories to retrieve (default: 3)

        Returns:
            List of dicts containing {text, metadata, distance}
        """
        results = self.collection.query(
            query_texts=[query],
            n_results=n
        )

        # Format the results
        memories = []
        if results['documents'] and results['documents'][0]:
            for i in range(len(results['documents'][0])):
                memory = {
                    'text': results['documents'][0][i],
                    'metadata': results['metadatas'][0][i],
                    'distance': results['distances'][0][i],
                    'id': results['ids'][0][i]
                }
                memories.append(memory)

        print(f"🔍 Recalled {len(memories)} memories for query: '{query[:50]}...'")
        return memories

    def forget(self, memory_id: str) -> bool:
        """
        Delete a specific memory (use with caution).

        Args:
            memory_id: The unique ID of the memory to delete

        Returns:
            True if successful, False otherwise
        """
        try:
            self.collection.delete(ids=[memory_id])
            print(f"🗑️ Memory deleted: {memory_id}")
            return True
        except Exception as e:
            print(f"❌ Failed to delete memory: {e}")
            return False

    def remember_preference(self, preference: str, category: str = "coding_style") -> str:
        """
        Store a user preference with special tagging for easy retrieval.

        This is a specialized memory function for tracking user preferences,
        coding styles, and personal guidelines.

        Args:
            preference: The preference statement to remember
            category: Category of preference (coding_style, workflow, communication, etc.)

        Returns:
            The unique ID of the stored preference
        """
        metadata = {
            "type": "user_preference",
            "category": category,
            "importance": "high",
            "timestamp": datetime.now().isoformat()
        }

        memory_id = self.remember(preference, metadata)
        print(f"⭐ Preference saved: {category}")
        return memory_id

    def recall_preferences(self, query: str = "coding preferences", n: int = 5) -> List[Dict[str, Any]]:
        """
        Retrieve user preferences from memory.

        Args:
            query: Search query for preferences
            n: Number of preferences to retrieve

        Returns:
            List of preference memories
        """
        # Query the collection specifically for preferences
        results = self.collection.query(
            query_texts=[query],
            n_results=n,
            where={"type": "user_preference"}  # Filter for preferences only
        )

        memories = []
        if results['documents'] and results['documents'][0]:
            for i in range(len(results['documents'][0])):
                memory = {
                    'text': results['documents'][0][i],
                    'metadata': results['metadatas'][0][i],
                    'distance': results['distances'][0][i],
                    'id': results['ids'][0][i]
                }
                memories.append(memory)

        print(f"⭐ Recalled {len(memories)} preferences")
        return memories

    def get_stats(self) -> Dict[str, Any]:
        """
        Get statistics about the memory system.

        Returns:
            Dict containing memory count and other stats
        """
        count = self.collection.count()
        return {
            "total_memories": count,
            "collection_name": self.collection.name,
            "metadata": self.collection.metadata
        }


# Singleton instance for global access
_memory_instance = None

def get_memory() -> Memory:
    """Get or create the global memory instance."""
    global _memory_instance
    if _memory_instance is None:
        _memory_instance = Memory()
    return _memory_instance


# Convenience functions for direct access
def remember(text: str, metadata: Optional[Dict[str, Any]] = None) -> str:
    """Store a new memory. Convenience wrapper."""
    return get_memory().remember(text, metadata)


def recall(query: str, n: int = 3) -> List[Dict[str, Any]]:
    """Retrieve relevant memories. Convenience wrapper."""
    return get_memory().recall(query, n)


def remember_preference(preference: str, category: str = "coding_style") -> str:
    """Store a user preference. Convenience wrapper."""
    return get_memory().remember_preference(preference, category)


def recall_preferences(query: str = "coding preferences", n: int = 5) -> List[Dict[str, Any]]:
    """Retrieve user preferences. Convenience wrapper."""
    return get_memory().recall_preferences(query, n)


if __name__ == "__main__":
    # Test the memory system
    print("=" * 60)
    print("O.R.I.O.N. MEMORY SYSTEM TEST")
    print("=" * 60)

    mem = Memory()

    # Store some test memories
    mem.remember(
        "O.R.I.O.N. was initialized on 2026-02-11",
        metadata={"type": "system", "importance": "high"}
    )
    mem.remember(
        "The kernel/plugin architecture ensures safe self-improvement",
        metadata={"type": "architecture", "importance": "critical"}
    )
    mem.remember(
        "Core modules are immutable and protected from updates",
        metadata={"type": "security", "importance": "critical"}
    )

    # Test recall
    print("\n" + "=" * 60)
    results = mem.recall("What is the architecture?", n=2)
    for i, memory in enumerate(results, 1):
        print(f"\nMemory {i}:")
        print(f"  Text: {memory['text']}")
        print(f"  Metadata: {memory['metadata']}")
        print(f"  Relevance: {1 - memory['distance']:.2%}")

    # Show stats
    print("\n" + "=" * 60)
    stats = mem.get_stats()
    print(f"Total memories: {stats['total_memories']}")
