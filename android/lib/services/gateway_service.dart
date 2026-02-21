/// OpenClaw Gateway client — connects as an Android node.
/// Speaks the OpenClaw WebSocket JSON-RPC protocol.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../config/zeke_config.dart';

enum GatewayState { disconnected, connecting, connected }

class GatewayService {
  WebSocketChannel? _channel;
  GatewayState _state = GatewayState.disconnected;
  Timer? _reconnectTimer;
  Timer? _tickTimer;
  int _reconnectAttempts = 0;
  int _rpcId = 0;

  final _messageController = StreamController<Map<String, dynamic>>.broadcast();
  final _stateController = StreamController<GatewayState>.broadcast();
  final Map<int, Completer<Map<String, dynamic>>> _pending = {};

  Stream<Map<String, dynamic>> get messages => _messageController.stream;
  Stream<GatewayState> get stateChanges => _stateController.stream;
  GatewayState get state => _state;

  /// Connect to ZEKE's OpenClaw gateway as an Android node.
  Future<void> connect() async {
    if (_state == GatewayState.connecting) return;
    _setState(GatewayState.connecting);

    try {
      final uri = Uri.parse('ws://${ZekeConfig.gatewayHost}:${ZekeConfig.gatewayPort}');
      _channel = WebSocketChannel.connect(uri);
      await _channel!.ready;

      _channel!.stream.listen(
        _onRawMessage,
        onDone: () => _onDisconnect('closed'),
        onError: (e) => _onDisconnect('error: $e'),
      );

      // Send OpenClaw connect handshake
      await _sendConnect();
    } catch (e) {
      _onDisconnect('connect failed: $e');
    }
  }

  /// OpenClaw JSON-RPC "connect" handshake.
  Future<void> _sendConnect() async {
    final result = await _rpc('connect', {
      'minProtocol': 1,
      'maxProtocol': 1,
      'client': {
        'id': 'openclaw-android',
        'displayName': 'ZEKE-Android',
        'version': ZekeConfig.appVersion,
        'platform': 'android',
        'mode': 'node',
      },
      'caps': ['system'],
      'commands': ['system.run'],
      'auth': {
        'token': ZekeConfig.gatewayToken,
      },
      'role': 'node',
      'scopes': [],
    });

    if (result.containsKey('error')) {
      _onDisconnect('auth failed');
      return;
    }

    _setState(GatewayState.connected);
    _reconnectAttempts = 0;

    // Start tick keepalive (every 30s)
    _tickTimer?.cancel();
    _tickTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      _send({'jsonrpc': '2.0', 'method': 'tick'});
    });
  }

  /// Send a JSON-RPC request and await response.
  Future<Map<String, dynamic>> _rpc(String method, Map<String, dynamic> params) {
    final id = ++_rpcId;
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;

    _send({
      'jsonrpc': '2.0',
      'id': id,
      'method': method,
      'params': params,
    });

    // Timeout after 10s
    Future.delayed(const Duration(seconds: 10), () {
      if (_pending.containsKey(id)) {
        _pending.remove(id)?.complete({'error': 'timeout'});
      }
    });

    return completer.future;
  }

  /// Send a chat message to ZEKE via the gateway.
  void sendMessage(String text) {
    _rpc('chat.send', {
      'text': text,
      'timestamp': DateTime.now().toIso8601String(),
    });
  }

  /// Stream an Opus audio frame to the gateway.
  void sendAudioFrame(Uint8List opusFrame) {
    if (_state != GatewayState.connected) return;
    _channel?.sink.add(opusFrame);
  }

  /// Send audio control signals.
  void sendAudioControl(String action) {
    _rpc('audio.$action', {
      'timestamp': DateTime.now().toIso8601String(),
    });
  }

  /// Send device context (location, activity).
  void sendContext(Map<String, dynamic> context) {
    _rpc('node.context', context);
  }

  void _send(Map<String, dynamic> data) {
    _channel?.sink.add(jsonEncode(data));
  }

  void _onRawMessage(dynamic raw) {
    try {
      if (raw is String) {
        final data = jsonDecode(raw) as Map<String, dynamic>;

        // Handle JSON-RPC response
        if (data.containsKey('id') && _pending.containsKey(data['id'])) {
          _pending.remove(data['id'])?.complete(data);
          return;
        }

        // Handle events from gateway
        final method = data['method'] as String?;
        if (method == 'node.invoke.request') {
          // Handle invoke requests from ZEKE
          _messageController.add(data);
        } else if (method == 'chat.reply' || method == 'chat.message') {
          _messageController.add({
            'type': 'chat.reply',
            'text': data['params']?['text'] ?? data['text'] ?? '',
          });
        }

        _messageController.add(data);
      }
    } catch (_) {}
  }

  void _onDisconnect(String reason) {
    _tickTimer?.cancel();
    _setState(GatewayState.disconnected);
    _channel = null;
    _pending.clear();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    final delayMs = (ZekeConfig.wsReconnectBaseMs *
            _pow(ZekeConfig.wsReconnectMultiplier, _reconnectAttempts))
        .clamp(ZekeConfig.wsReconnectBaseMs, ZekeConfig.wsReconnectMaxMs)
        .toInt();
    _reconnectAttempts++;
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () => connect());
  }

  void _setState(GatewayState s) {
    _state = s;
    _stateController.add(s);
  }

  double _pow(double base, int exp) {
    double result = 1.0;
    for (var i = 0; i < exp; i++) result *= base;
    return result;
  }

  void disconnect() {
    _reconnectTimer?.cancel();
    _tickTimer?.cancel();
    _channel?.sink.close();
    _channel = null;
    _setState(GatewayState.disconnected);
  }

  void dispose() {
    disconnect();
    _messageController.close();
    _stateController.close();
  }
}
