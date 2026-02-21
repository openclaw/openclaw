/// BLE scanner and connection manager.
/// Discovers Limitless pendants, Omi DevKits, and MimiClaw ESP32 devices.

import 'dart:async';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import '../config/zeke_config.dart';
import '../models/device.dart';

class BleService {
  final _devicesController = StreamController<List<BleDevice>>.broadcast();
  final Map<String, BleDevice> _discovered = {};
  final Map<String, BluetoothDevice> _rawDevices = {};
  StreamSubscription? _scanSub;
  bool _scanning = false;

  Stream<List<BleDevice>> get devices => _devicesController.stream;
  List<BleDevice> get discoveredDevices => _discovered.values.toList();
  bool get isScanning => _scanning;

  /// Start scanning for supported BLE devices.
  Future<void> startScan({Duration timeout = const Duration(seconds: 10)}) async {
    if (_scanning) return;
    _scanning = true;

    _scanSub = FlutterBluePlus.scanResults.listen((results) {
      for (final r in results) {
        final id = r.device.remoteId.str;
        final name = r.device.platformName.isNotEmpty
            ? r.device.platformName
            : r.advertisementData.advName;
        if (name.isEmpty) continue;

        final serviceUuids =
            r.advertisementData.serviceUuids.map((u) => u.str).toList();
        final type = BleDevice.detectType(name, serviceUuids);

        // Only show supported devices
        if (type == DeviceType.unknown) continue;

        _rawDevices[id] = r.device;
        _discovered[id] = BleDevice(
          id: id,
          name: name,
          type: type,
          lastSeen: DateTime.now(),
        );
      }
      _devicesController.add(_discovered.values.toList());
    });

    await FlutterBluePlus.startScan(
      timeout: timeout,
      withServices: [
        Guid(ZekeConfig.limitlessServiceUuid),
        Guid(ZekeConfig.omiServiceUuid),
      ],
    );
    _scanning = false;
  }

  void stopScan() {
    FlutterBluePlus.stopScan();
    _scanSub?.cancel();
    _scanning = false;
  }

  /// Get the raw BluetoothDevice for a discovered device ID.
  BluetoothDevice? getRawDevice(String id) => _rawDevices[id];

  void dispose() {
    stopScan();
    _devicesController.close();
  }
}
