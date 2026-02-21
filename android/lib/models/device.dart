/// BLE device model — Limitless pendant, Omi DevKit, or ESP32 MimiClaw.

enum DeviceType { limitless, omi, mimiclaw, unknown }

enum DeviceState { disconnected, connecting, connected, streaming }

class BleDevice {
  final String id; // MAC address
  final String name;
  final DeviceType type;
  DeviceState state;
  int? batteryLevel;
  String? firmwareVersion;
  DateTime? lastSeen;
  bool autoConnect;

  BleDevice({
    required this.id,
    required this.name,
    required this.type,
    this.state = DeviceState.disconnected,
    this.batteryLevel,
    this.firmwareVersion,
    this.lastSeen,
    this.autoConnect = true,
  });

  static DeviceType detectType(String name, List<String> serviceUuids) {
    if (serviceUuids.any((u) => u.toLowerCase().contains('632de001'))) {
      return DeviceType.limitless;
    }
    if (serviceUuids.any((u) => u.toLowerCase().contains('19b10000'))) {
      return DeviceType.omi;
    }
    if (name.toLowerCase().contains('mimiclaw') || name.toLowerCase().contains('esp32')) {
      return DeviceType.mimiclaw;
    }
    return DeviceType.unknown;
  }

  String get typeLabel {
    switch (type) {
      case DeviceType.limitless:
        return 'Limitless Pendant';
      case DeviceType.omi:
        return 'Omi DevKit';
      case DeviceType.mimiclaw:
        return 'MimiClaw ESP32';
      case DeviceType.unknown:
        return 'Unknown Device';
    }
  }

  String get stateLabel {
    switch (state) {
      case DeviceState.disconnected:
        return 'Disconnected';
      case DeviceState.connecting:
        return 'Connecting...';
      case DeviceState.connected:
        return 'Connected';
      case DeviceState.streaming:
        return 'Streaming Audio';
    }
  }
}
