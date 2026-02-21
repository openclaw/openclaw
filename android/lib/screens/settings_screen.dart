/// Settings screen — gateway status, location toggle, about.

import 'package:flutter/material.dart';
import '../config/zeke_config.dart';
import '../services/gateway_service.dart';
import '../services/location_service.dart';

class SettingsScreen extends StatefulWidget {
  final GatewayService gateway;
  final LocationService location;

  const SettingsScreen({super.key, required this.gateway, required this.location});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0E0E0E),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1A1A1A),
        title: const Text('Settings'),
      ),
      body: ListView(
        children: [
          _section('Connection'),
          _tile('Gateway', ZekeConfig.gatewayWss,
              trailing: _stateDot(widget.gateway.state)),
          _tile('Bot', ZekeConfig.botHandle),
          _tile('Version', ZekeConfig.appVersion),

          _section('Context'),
          SwitchListTile(
            title: const Text('Share Location', style: TextStyle(color: Colors.white)),
            subtitle: Text('Send GPS to ${ZekeConfig.botName} for context',
                style: TextStyle(color: Colors.grey[500])),
            value: widget.location.enabled,
            onChanged: (v) async {
              if (v) {
                await widget.location.start();
              } else {
                widget.location.stop();
              }
              setState(() {});
            },
          ),

          _section('Actions'),
          ListTile(
            leading: const Icon(Icons.refresh, color: Colors.orange),
            title: const Text('Reconnect Gateway', style: TextStyle(color: Colors.white)),
            onTap: () {
              widget.gateway.disconnect();
              widget.gateway.connect();
            },
          ),

          _section('About'),
          _tile('${ZekeConfig.appTitle} Node App', 'OpenClaw Android Node with Limitless pendant support'),
          _tile('Made by', 'ZEKE + Nate Johnson'),
        ],
      ),
    );
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
        child: Text(title, style: const TextStyle(color: Color(0xFF4A9EFF), fontWeight: FontWeight.w600)),
      );

  Widget _tile(String title, String subtitle, {Widget? trailing}) => ListTile(
        title: Text(title, style: const TextStyle(color: Colors.white)),
        subtitle: Text(subtitle, style: TextStyle(color: Colors.grey[500])),
        trailing: trailing,
      );

  Widget _stateDot(GatewayState state) {
    final color = state == GatewayState.connected
        ? Colors.green
        : state == GatewayState.connecting
            ? Colors.orange
            : Colors.red;
    return Container(
      width: 10, height: 10,
      decoration: BoxDecoration(shape: BoxShape.circle, color: color),
    );
  }
}
