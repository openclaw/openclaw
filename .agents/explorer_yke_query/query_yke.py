import sqlite3

def test_query():
    db_path = "/Users/jakeshrader/Desktop/Code/youtube-knowledge-engine/data/knowledge.db"
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()
    print("Tables:", tables)
    conn.close()

if __name__ == "__main__":
    test_query()
