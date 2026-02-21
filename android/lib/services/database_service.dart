/// Local SQLite message store.

import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';
import '../models/message.dart';

class DatabaseService {
  Database? _db;

  Future<Database> get database async {
    _db ??= await _initDb();
    return _db!;
  }

  Future<Database> _initDb() async {
    final path = join(await getDatabasesPath(), 'zeke_chat.db');
    return openDatabase(path, version: 1, onCreate: (db, version) async {
      await db.execute('''
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          is_user INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          audio_path TEXT
        )
      ''');
    });
  }

  Future<int> insertMessage(ChatMessage msg) async {
    final db = await database;
    return db.insert('messages', msg.toMap());
  }

  Future<List<ChatMessage>> getMessages({int limit = 100, int offset = 0}) async {
    final db = await database;
    final maps = await db.query('messages',
        orderBy: 'timestamp DESC', limit: limit, offset: offset);
    return maps.map((m) => ChatMessage.fromMap(m)).toList().reversed.toList();
  }

  Future<void> clearAll() async {
    final db = await database;
    await db.delete('messages');
  }
}
