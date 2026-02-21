/// Main chat screen — Telegram-style message UI with ZEKE.

import 'package:flutter/material.dart';
import '../config/zeke_config.dart';
import '../models/message.dart';
import '../services/gateway_service.dart';
import '../services/database_service.dart';
import '../widgets/message_bubble.dart';
import '../widgets/pendant_status.dart';
import '../models/device.dart';

class ChatScreen extends StatefulWidget {
  final GatewayService gateway;
  final DatabaseService db;
  final DeviceState pendantState;
  final int audioFrames;
  final VoidCallback onDevicesTap;
  final VoidCallback onSettingsTap;

  const ChatScreen({
    super.key,
    required this.gateway,
    required this.db,
    required this.pendantState,
    required this.audioFrames,
    required this.onDevicesTap,
    required this.onSettingsTap,
  });

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _textController = TextEditingController();
  final _scrollController = ScrollController();
  final List<ChatMessage> _messages = [];

  @override
  void initState() {
    super.initState();
    _loadMessages();
    widget.gateway.messages.listen(_onGatewayMessage);
  }

  Future<void> _loadMessages() async {
    final msgs = await widget.db.getMessages();
    setState(() => _messages.addAll(msgs));
  }

  void _onGatewayMessage(Map<String, dynamic> data) {
    if (data['type'] == 'chat.reply') {
      final msg = ChatMessage(text: data['text'] ?? '', isUser: false);
      widget.db.insertMessage(msg);
      setState(() {
        _messages.add(msg);
        _scrollToBottom();
      });
    }
  }

  void _sendMessage() {
    final text = _textController.text.trim();
    if (text.isEmpty) return;

    final msg = ChatMessage(text: text, isUser: true);
    widget.db.insertMessage(msg);
    widget.gateway.sendMessage(text);

    setState(() {
      _messages.add(msg);
      _textController.clear();
      _scrollToBottom();
    });
  }

  void _scrollToBottom() {
    Future.delayed(const Duration(milliseconds: 100), () {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0E0E0E),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1A1A1A),
        title: Row(
          children: [
            const CircleAvatar(
              radius: 18,
              backgroundColor: Color(0xFF4A9EFF),
              child: Text('Z', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(ZekeConfig.appTitle,
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                PendantStatusBadge(
                  state: widget.pendantState,
                  gatewayState: widget.gateway.state,
                  frameCount: widget.audioFrames,
                ),
              ],
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.bluetooth),
            onPressed: widget.onDevicesTap,
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: widget.onSettingsTap,
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: _messages.isEmpty
                ? Center(
                    child: Text('Say something to ${ZekeConfig.botName}',
                        style: TextStyle(color: Colors.grey[600])),
                  )
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(12),
                    itemCount: _messages.length,
                    itemBuilder: (_, i) => MessageBubble(message: _messages[i]),
                  ),
          ),
          _buildInputBar(),
        ],
      ),
    );
  }

  Widget _buildInputBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      color: const Color(0xFF1A1A1A),
      child: SafeArea(
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _textController,
                style: const TextStyle(color: Colors.white),
                decoration: InputDecoration(
                  hintText: 'Message ${ZekeConfig.botName}...',
                  hintStyle: TextStyle(color: Colors.grey[600]),
                  filled: true,
                  fillColor: const Color(0xFF2A2A2A),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                ),
                onSubmitted: (_) => _sendMessage(),
              ),
            ),
            const SizedBox(width: 6),
            CircleAvatar(
              backgroundColor: const Color(0xFF4A9EFF),
              child: IconButton(
                icon: const Icon(Icons.send, color: Colors.white, size: 20),
                onPressed: _sendMessage,
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    super.dispose();
  }
}
