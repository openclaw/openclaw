/// BLE device discovery and connection screen.

import 'package:flutter/material.dart';
import '../services/ble_service.dart';
import '../services/limitless_service.dart';
import '../models/device.dart';
import '../widgets/device_card.dart';

class DevicesScreen extends StatefulWidget {
  final BleService bleService;
  final LimitlessService limitlessService;
  final Function(BleDevice) onDeviceConnected;

  const DevicesScreen({
    super.key,
    required this.bleService,
    required this.limitlessService,
    required this.onDeviceConnected,
  });

  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<BleDevice> _devices = [];
  bool _scanning = false;

  @override
  void initState() {
    super.initState();
    widget.bleService.devices.listen((d) => setState(() => _devices = d));
    _startScan();
  }

  Future<void> _startScan() async {
    setState(() => _scanning = true);
    await widget.bleService.startScan();
    setState(() => _scanning = false);
  }

  Future<void> _connectDevice(BleDevice device) async {
    final raw = widget.bleService.getRawDevice(device.id);
    if (raw == null) return;

    setState(() => device.state = DeviceState.connecting);

    final success = await widget.limitlessService.connect(raw);
    if (success) {
      device.state = DeviceState.streaming;
      widget.onDeviceConnected(device);
      if (mounted) Navigator.pop(context);
    } else {
      setState(() => device.state = DeviceState.disconnected);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to connect to ${device.name}')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0E0E0E),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1A1A1A),
        title: const Text('Devices'),
        actions: [
          if (_scanning)
            const Padding(
              padding: EdgeInsets.all(16),
              child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else
            IconButton(icon: const Icon(Icons.refresh), onPressed: _startScan),
        ],
      ),
      body: _devices.isEmpty
          ? Center(
              child: Text(
                _scanning ? 'Scanning for devices...' : 'No devices found\nTap refresh to scan again',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey[600]),
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(12),
              itemCount: _devices.length,
              itemBuilder: (_, i) => DeviceCard(
                device: _devices[i],
                onConnect: () => _connectDevice(_devices[i]),
              ),
            ),
    );
  }
}
