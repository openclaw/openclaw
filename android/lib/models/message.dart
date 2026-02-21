/// Chat message model for local storage and display.

class ChatMessage {
  final int? id;
  final String text;
  final bool isUser;
  final DateTime timestamp;
  final String? audioPath;

  ChatMessage({
    this.id,
    required this.text,
    required this.isUser,
    DateTime? timestamp,
    this.audioPath,
  }) : timestamp = timestamp ?? DateTime.now();

  Map<String, dynamic> toMap() => {
        'text': text,
        'is_user': isUser ? 1 : 0,
        'timestamp': timestamp.millisecondsSinceEpoch,
        'audio_path': audioPath,
      };

  factory ChatMessage.fromMap(Map<String, dynamic> map) => ChatMessage(
        id: map['id'] as int?,
        text: map['text'] as String,
        isUser: (map['is_user'] as int) == 1,
        timestamp: DateTime.fromMillisecondsSinceEpoch(map['timestamp'] as int),
        audioPath: map['audio_path'] as String?,
      );
}
