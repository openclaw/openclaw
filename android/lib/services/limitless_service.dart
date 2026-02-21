/// Limitless pendant BLE protocol handler.
/// Connects, initializes, and streams Opus audio from the pendant.

import 'dart:async';
import 'dart:typed_data';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import '../config/zeke_config.dart';
import '../models/device.dart';
import '../models/pendant_protocol.dart';

class LimitlessService {
  BluetoothDevice? _device;
  BluetoothCharacteristic? _txChar;
  BluetoothCharacteristic? _rxChar;
  StreamSubscription? _notifySub;
  final PacketReassembler _reassembler = PacketReassembler();

  final _audioController = StreamController<Uint8List>.broadcast();
  final _stateController = StreamController<DeviceState>.broadcast();
  DeviceState _state = DeviceState.disconnected;

  Stream<Uint8List> get audioFrames => _audioController.stream;
  Stream<DeviceState> get stateChanges => _stateController.stream;
  DeviceState get state => _state;

  int _frameCount = 0;
  int get frameCount => _frameCount;

  /// Connect to a Limitless pendant and start audio streaming.
  Future<bool> connect(BluetoothDevice device) async {
    try {
      _device = device;
      _setState(DeviceState.connecting);

      await device.connect(timeout: const Duration(seconds: 10));
      final services = await device.discoverServices();

      // Find Limitless service
      final service = services.firstWhere(
        (s) => s.uuid.str.toLowerCase() == ZekeConfig.limitlessServiceUuid,
        orElse: () => throw Exception('Limitless service not found'),
      );

      // Get TX and RX characteristics
      _txChar = service.characteristics.firstWhere(
        (c) => c.uuid.str.toLowerCase() == ZekeConfig.limitlessTxUuid,
      );
      _rxChar = service.characteristics.firstWhere(
        (c) => c.uuid.str.toLowerCase() == ZekeConfig.limitlessRxUuid,
      );

      // Initialize pendant
      await _initialize();
      _setState(DeviceState.streaming);
      return true;
    } catch (e) {
      _setState(DeviceState.disconnected);
      return false;
    }
  }

  /// Pendant initialization sequence (from Omi source).
  Future<void> _initialize() async {
    // 1. Time sync
    await _txChar!.write(
      PendantCommands.encodeSetCurrentTime(DateTime.now()).toList(),
      withoutResponse: false,
    );
    await Future.delayed(const Duration(seconds: 1));

    // 2. Enable data stream
    await _txChar!.write(
      PendantCommands.encodeEnableDataStream().toList(),
      withoutResponse: false,
    );
    await Future.delayed(const Duration(seconds: 1));

    // 3. Subscribe to RX notifications
    await _rxChar!.setNotifyValue(true);
    _reassembler.clear();
    _frameCount = 0;

    _notifySub = _rxChar!.onValueReceived.listen((data) {
      _onBleData(Uint8List.fromList(data));
    });
  }

  /// Handle incoming BLE data — reassemble fragments, extract Opus frames.
  void _onBleData(Uint8List data) {
    final complete = _reassembler.addFragment(data);
    if (complete != null) {
      final frames = OpusExtractor.extractFrames(complete);
      for (final frame in frames) {
        _frameCount++;
        _audioController.add(frame);
      }
    }
  }

  /// Disconnect from the pendant.
  Future<void> disconnect() async {
    _notifySub?.cancel();
    _reassembler.clear();
    try {
      if (_txChar != null) {
        await _txChar!.write(
          PendantCommands.encodeDisableDataStream().toList(),
          withoutResponse: false,
        );
      }
    } catch (_) {}
    try {
      await _device?.disconnect();
    } catch (_) {}
    _device = null;
    _txChar = null;
    _rxChar = null;
    _setState(DeviceState.disconnected);
  }

  void _setState(DeviceState s) {
    _state = s;
    _stateController.add(s);
  }

  void dispose() {
    disconnect();
    _audioController.close();
    _stateController.close();
  }
}
