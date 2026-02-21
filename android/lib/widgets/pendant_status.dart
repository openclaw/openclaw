import 'package:flutter/material.dart';
import '../models/device.dart';
import '../services/gateway_service.dart';

class PendantStatusBadge extends StatelessWidget {
  final DeviceState state;
  final GatewayState gatewayState;
  final int frameCount;

  const PendantStatusBadge({
    super.key,
    required this.state,
    required this.gatewayState,
    required this.frameCount,
  });

  @override
  Widget build(BuildContext context) {
    String text;
    Color color;

    if (gatewayState != GatewayState.connected) {
      text = 'Connecting to ZEKE...';
      color = Colors.orange;
    } else if (state == DeviceState.streaming) {
      text = 'Streaming • $frameCount frames';
      color = Colors.green;
    } else if (state == DeviceState.connected) {
      text = 'Pendant connected';
      color = Colors.green;
    } else if (state == DeviceState.connecting) {
      text = 'Connecting pendant...';
      color = Colors.orange;
    } else {
      text = 'Online • No pendant';
      color = Colors.grey;
    }

    return Row(
      children: [
        Container(
          width: 7, height: 7,
          decoration: BoxDecoration(shape: BoxShape.circle, color: color),
        ),
        const SizedBox(width: 5),
        Text(text, style: TextStyle(fontSize: 12, color: color)),
      ],
    );
  }
}
