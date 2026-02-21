/// ZEKE AI — OpenClaw Android Node with Limitless Pendant Support
/// Hardcoded to connect directly to ZEKE's gateway. Zero config needed.

import 'package:flutter/material.dart';
import 'config/zeke_config.dart';
import 'models/device.dart';
import 'services/gateway_service.dart';
import 'services/ble_service.dart';
import 'services/limitless_service.dart';
import 'services/audio_service.dart';
import 'services/database_service.dart';
import 'services/location_service.dart';
import 'screens/chat_screen.dart';
import 'screens/devices_screen.dart';
import 'screens/settings_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ZekeApp());
}

class ZekeApp extends StatelessWidget {
  const ZekeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: ZekeConfig.appTitle,
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF0E0E0E),
        colorScheme: const ColorScheme.dark(primary: Color(0xFF4A9EFF)),
      ),
      home: const ZekeHome(),
    );
  }
}

class ZekeHome extends StatefulWidget {
  const ZekeHome({super.key});

  @override
  State<ZekeHome> createState() => _ZekeHomeState();
}

class _ZekeHomeState extends State<ZekeHome> {
  late final GatewayService _gateway;
  late final BleService _ble;
  late final LimitlessService _limitless;
  late final AudioService _audio;
  late final DatabaseService _db;
  late final LocationService _location;

  DeviceState _pendantState = DeviceState.disconnected;
  int _audioFrames = 0;

  @override
  void initState() {
    super.initState();
    _gateway = GatewayService();
    _ble = BleService();
    _limitless = LimitlessService();
    _db = DatabaseService();
    _location = LocationService(_gateway);
    _audio = AudioService(_gateway, _limitless);

    // Auto-connect to ZEKE on launch
    _gateway.connect();

    // Listen to pendant state
    _limitless.stateChanges.listen((state) {
      setState(() => _pendantState = state);
      if (state == DeviceState.streaming) {
        _audio.startPendantStream();
      }
    });

    // Track audio frames
    _limitless.audioFrames.listen((_) {
      setState(() => _audioFrames = _limitless.frameCount);
    });
  }

  void _openDevices() {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => DevicesScreen(
          bleService: _ble,
          limitlessService: _limitless,
          onDeviceConnected: (device) {
            setState(() => _pendantState = device.state);
          },
        ),
      ),
    );
  }

  void _openSettings() {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => SettingsScreen(gateway: _gateway, location: _location),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ChatScreen(
      gateway: _gateway,
      db: _db,
      pendantState: _pendantState,
      audioFrames: _audioFrames,
      onDevicesTap: _openDevices,
      onSettingsTap: _openSettings,
    );
  }

  @override
  void dispose() {
    _audio.dispose();
    _limitless.dispose();
    _ble.dispose();
    _gateway.dispose();
    _location.dispose();
    super.dispose();
  }
}
