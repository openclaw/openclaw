import 'package:flutter/material.dart';
import '../models/device.dart';

class DeviceCard extends StatelessWidget {
  final BleDevice device;
  final VoidCallback onConnect;

  const DeviceCard({super.key, required this.device, required this.onConnect});

  @override
  Widget build(BuildContext context) {
    final icon = switch (device.type) {
      DeviceType.limitless => Icons.podcasts,
      DeviceType.omi => Icons.headset,
      DeviceType.mimiclaw => Icons.memory,
      DeviceType.unknown => Icons.bluetooth,
    };

    return Card(
      color: const Color(0xFF1A1A1A),
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        leading: Icon(icon, color: const Color(0xFF4A9EFF), size: 32),
        title: Text(device.name, style: const TextStyle(color: Colors.white)),
        subtitle: Text('${device.typeLabel} • ${device.stateLabel}',
            style: TextStyle(color: Colors.grey[500])),
        trailing: device.state == DeviceState.disconnected
            ? ElevatedButton(
                onPressed: onConnect,
                style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF4A9EFF)),
                child: const Text('Connect'),
              )
            : device.state == DeviceState.connecting
                ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.check_circle, color: Colors.green),
      ),
    );
  }
}
